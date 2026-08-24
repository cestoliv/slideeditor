// `npm run dev` runs this under tsx, so the API restarts on a source edit without
// a build. The shipped binary is bin/slide-studio.mjs, which runs the same main.
import { main } from "./cli.js";

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
