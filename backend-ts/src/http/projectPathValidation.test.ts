import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { validateProjectPath } from "./projectPathValidation.ts";
test("path validation distinguishes nonexistent/file/directory/Git without shell evaluation", async () => {
 const root=mkdtempSync(join(tmpdir(),"xw-path-"));
 try {
  expect((await validateProjectPath("relative")).exists).toBe(false);
  expect((await validateProjectPath(join(root,"missing"))).exists).toBe(false);
  writeFileSync(join(root,"file"),"data");expect((await validateProjectPath(join(root,"file"))).is_directory).toBe(false);
  expect(await validateProjectPath(root)).toMatchObject({exists:true,is_directory:true,is_git_repository:false});
  execFileSync("git",["init","-q",root]);expect(await validateProjectPath(root)).toMatchObject({exists:true,is_directory:true,is_git_repository:true,reason:""});
  expect((await validateProjectPath(`${root}/$(touch unwanted)`)).exists).toBe(false);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test("Git ownership and availability failures do not claim the directory is not a repository", async () => {
 const {projectGitFailureReason}=await import("./projectPathValidation.ts");
 expect(projectGitFailureReason({stderr:"fatal: detected dubious ownership; safe.directory"})).toContain("Git 拒绝读取");
 expect(projectGitFailureReason({code:"ENOENT"})).toContain("Git 不可用");
 expect(projectGitFailureReason({stderr:"fatal: not a git repository"})).toBe("这个目录不是 Git 仓库");
});
