#include <git2.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif

static int read_u32(uint32_t *value) {
  unsigned char b[4];
  if (fread(b, 1, 4, stdin) != 4) return -1;
  *value = ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) | ((uint32_t)b[2] << 8) | b[3];
  return 0;
}
/* Input contains two snapshots: count, then repeated path length, byte length,
 * UTF-8 path and raw bytes. It never contains shell commands or credentials. */
static int tree(git_tree **out, git_repository *repo) {
  uint32_t count;
  git_index *index = NULL;
  if (read_u32(&count) || count > 100000 || git_index_new(&index)) return -1;
  int result = -1;
  for (uint32_t i = 0; i < count; i++) {
    uint32_t plen, length;
    if (read_u32(&plen) || read_u32(&length) || plen == 0 || plen > 32768 || length > 256 * 1024 * 1024) goto done;
    char *path = calloc((size_t)plen + 1, 1);
    void *bytes = malloc(length ? length : 1);
    if (!path || !bytes) { free(path); free(bytes); goto done; }
    if (fread(path, 1, plen, stdin) != plen || fread(bytes, 1, length, stdin) != length || strlen(path) != plen) {
      free(path); free(bytes); goto done;
    }
    git_index_entry entry = {0};
    entry.mode = GIT_FILEMODE_BLOB;
    entry.path = path;
    entry.file_size = length;
    int err = git_blob_create_from_buffer(&entry.id, repo, bytes, length);
    if (!err) err = git_index_add(index, &entry);
    free(bytes); free(path);
    if (err) goto done;
  }
  git_oid oid;
  if (git_index_write_tree_to(&oid, index, repo) || git_tree_lookup(out, repo, &oid)) goto done;
  result = 0;
done:
  git_index_free(index);
  return result;
}
static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
#ifdef _WIN32
  _setmode(_fileno(stdin), 0x8000);
#endif
  git_libgit2_init();
  git_repository *repo = NULL;
  git_tree *before = NULL, *after = NULL;
  git_diff *diff = NULL;
  int result = 1;
  if (git_repository_init(&repo, argv[1], 1) || tree(&before, repo) || tree(&after, repo)) goto done;
  git_diff_options options = GIT_DIFF_OPTIONS_INIT;
  if (git_diff_tree_to_tree(&diff, repo, before, after, &options)) goto done;
  git_diff_find_options find = GIT_DIFF_FIND_OPTIONS_INIT;
  find.flags = GIT_DIFF_FIND_RENAMES;
  find.rename_threshold = 70;
  find.rename_limit = 1000;
  if (git_diff_find_similar(diff, &find)) goto done;
  printf("[");
  int first = 1;
  for (size_t i = 0; i < git_diff_num_deltas(diff); i++) {
    const git_diff_delta *delta = git_diff_get_delta(diff, i);
    if (delta->status != GIT_DELTA_RENAMED) continue;
    if (!first) printf(",");
    first = 0;
    printf("{\"from\":"); json_string(delta->old_file.path);
    printf(",\"to\":"); json_string(delta->new_file.path);
    printf(",\"similarity\":%u}", delta->similarity);
  }
  printf("]\n"); result = 0;
done:
  if (result) { const git_error *err = git_error_last(); fprintf(stderr, "libgit2 rename scan failed: %s\n", err ? err->message : "invalid input"); }
  git_diff_free(diff); git_tree_free(before); git_tree_free(after); git_repository_free(repo);
  git_libgit2_shutdown();
  return result;
}
