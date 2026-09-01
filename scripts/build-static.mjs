import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL("../dist/", import.meta.url));

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of ["index.html", "styles.css", "tokens.css"]) {
  await cp(new URL(`../${file}`, import.meta.url), new URL(`../dist/${file}`, import.meta.url));
}

await cp(new URL("../src/", import.meta.url), new URL("../dist/src/", import.meta.url), {
  recursive: true
});

console.log(`Built Host Stand static assets from ${root} into ${output}`);
