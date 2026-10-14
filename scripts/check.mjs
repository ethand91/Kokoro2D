import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
async function check(directory) {
  for (const file of await readdir(directory,{withFileTypes:true})) {
    const path=`${directory}/${file.name}`;
    if(file.isDirectory())await check(path);
    else if(/\.m?js$/.test(file.name)) {
      const result=spawnSync(process.execPath,["--check",path],{stdio:"inherit"});
      if(result.status!==0)process.exit(result.status??1);
    }
  }
}
await check("src");await check("scripts");
const result=spawnSync(process.execPath,["--test"],{stdio:"inherit"});process.exit(result.status??1);
