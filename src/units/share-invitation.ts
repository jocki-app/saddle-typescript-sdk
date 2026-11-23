import { isValidAutomergeUrl } from "@automerge/automerge-repo";
import { z } from "zod";
import { base64, unbase64, text, utf8 } from "../crypto.js";
import type { ShareInvitation } from "./protected-sync.js";
const invitationSchema = z
  .object({
    format: z.literal("saddle-share-invitation/1"),
    url: z.string().refine(isValidAutomergeUrl),
    name: z.string().max(4096),
    kind: z.enum(["workspace", "vault", "folder", "file"]),
  })
  .strict();
const prefix = "saddle://share/";
export function shareLink(invitation: ShareInvitation): string {
  return (
    prefix +
    base64(utf8.encode(JSON.stringify(invitationSchema.parse(invitation))))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  );
}
/** Preview only. Admission must verify the referenced signed share contract. */
export function parseShareLink(value: string): ShareInvitation {
  value = value.trim();
  if (value.length > 20000 || !value.startsWith(prefix))
    throw Error("Paste a SADDLE sync link");
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded))
    throw Error("Invalid SADDLE sync link");
  try {
    const data = encoded.replace(/-/g, "+").replace(/_/g, "/");
    return invitationSchema.parse(
      JSON.parse(
        text.decode(unbase64(data + "=".repeat((4 - (data.length % 4)) % 4))),
      ),
    );
  } catch {
    throw Error("Invalid SADDLE sync link");
  }
}
