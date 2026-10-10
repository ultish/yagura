import { actionAgentCli } from "../../action-cli.js";
import { doctorCli } from "../../doctor.js";
import { evidenceCli } from "../../evidence-cli.js";
import { RECORD_COMMANDS, recordCli } from "../../record-cli.js";

const argv = process.argv.slice(2);
const result = (RECORD_COMMANDS as readonly string[]).includes(argv[0] ?? "")
  ? await recordCli(argv)
  : argv[0] === "action"
    ? await actionAgentCli(argv.slice(1))
    : argv[0] === "doctor"
      ? await doctorCli(argv.slice(1))
      : await evidenceCli(argv[0] === "evidence" ? argv.slice(1) : argv);
process.stdout.write(result.output);
process.exit(result.code);
