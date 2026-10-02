/*
 * A backend process that starts a run and is then killed by the parent test
 * (tests/exec-runtime.integration.test.ts, "a backend killed mid-run…"). It
 * gets the same environment as the parent, runs one call with a long inline
 * wait, and never returns on its own before the program ends.
 */
import { executeRunCode } from "@/lib/exec/runtime";

const [userId, conversationId, sessionId, callId] = process.argv.slice(2);

async function main(): Promise<void> {
  await executeRunCode(
  {
    language: "python",
    code: "import time\ntime.sleep(6)\nopen('late.txt', 'w').write('written after the backend died')\nprint('finished later')\n",
  },
  { surface: "chat", userId, sessionId, callId, conversationId, projectId: null, vision: false, lockdown: false },
  );
}

void main().then(() => process.exit(0));
