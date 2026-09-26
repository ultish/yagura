import { evidenceCli } from "../../evidence-cli.js";

const argv = process.argv.slice(2);
const result = await evidenceCli(argv[0] === "evidence" ? argv.slice(1) : argv);
process.stdout.write(result.output);
process.exit(result.code);
