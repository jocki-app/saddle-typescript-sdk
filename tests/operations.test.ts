import {it,expect} from "vitest";
import {mkdtemp,writeFile,readFile,rm,lstat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import * as A from "@automerge/automerge";
import {operate} from "../src/node/operations";
import {NodeVaultFiles} from "../src/node/vault-files";
import {RecordFiles} from "../src/units/record-container";
it("keeps private runtime profiles out of an opened folder's history",async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),"saddle-operations-")),root=path.join(parent,"files"),profile=path.join(root,"private");
 const fs=await NodeVaultFiles.open(root);
 try {
  await writeFile(path.join(root,"note.md"),"hello");
  await operate({method:"history.configure",target:root,state:"enabled",profile});
  const records=new RecordFiles(await NodeVaultFiles.open(parent),".files.saddle");
  const folder=A.load<{children:Record<string,{name:string}>}>((await records.read("folder.automerge"))!);
  try{expect(Object.values(folder.children).map(child=>child.name)).toEqual(["note.md"]);}finally{A.free(folder);}
  expect((await lstat(profile)).isDirectory()).toBe(true);
  expect((await operate({method:"unit.inspect",target:path.join(root,"note.md"),profile}) as any).features.history).toBe(false);
 } finally {await rm(parent,{recursive:true,force:true});}
});
