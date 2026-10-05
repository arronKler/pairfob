import { parseAgentTraceDetail, parseAgentTraceSummaryPage, type AgentTraceItem } from "../src/lib/operations";

/**
 * What the daemon answered for one real session of each agent (cursor-agent
 * 2026.08.11, Hermes Agent 0.19.1, opencode 1.1.28): the AgentTraceSummary
 * reply with markers, labels and times, and the AgentTraceDetail reply for
 * each tool. Captured through the daemon's RPC; only the working directory and
 * the account name were replaced. The scenes read them with the production
 * parsers, so they show what a phone shows for these agents.
 */
type Recorded = { summary: unknown; details: Record<string, unknown> };

export type RecordedAgent = "cursor" | "hermes" | "opencode";

const RECORDED: Record<RecordedAgent, Recorded> = {
  "cursor": {
    "details": {
      "ZDE6VUJESHhaOE5jUHhFQjRBXzo0MzY6MTo0U2Z5OG1nazFHazozZ3A3OFpWT29rMA": {
        "detail_ref": "ZDE6VUJESHhaOE5jUHhFQjRBXzo0MzY6MTo0U2Z5OG1nazFHazozZ3A3OFpWT29rMA",
        "input": "{\"path\":\"/work/demo/note.txt\"}",
        "truncated": false
      },
      "ZDE6VUJESHhaOE5jUHhFQjRBXzo3NTI6MTo5RVctREFwTUs5NDpLSXFjN1prcXQ3UQ": {
        "detail_ref": "ZDE6VUJESHhaOE5jUHhFQjRBXzo3NTI6MTo5RVctREFwTUs5NDpLSXFjN1prcXQ3UQ",
        "input": "{\"command\":\"echo 'world' >> note.txt\",\"working_directory\":\"/work/demo\",\"description\":\"Append world to note.txt\"}",
        "truncated": false
      },
      "ZDE6VUJESHhaOE5jUHhFQjRBXzoxMTU3OjA6OUVXLURBcE1LOTQ6NXB1MTVoR0liVXc": {
        "detail_ref": "ZDE6VUJESHhaOE5jUHhFQjRBXzoxMTU3OjA6OUVXLURBcE1LOTQ6NXB1MTVoR0liVXc",
        "input": "{\"command\":\"ls -la\",\"description\":\"List files with details\",\"working_directory\":\"/work/demo\"}",
        "truncated": false
      },
      "ZDE6VUJESHhaOE5jUHhFQjRBXzoxNDQ4OjA6OUVXLURBcE1LOTQ6YXBIRFQzU3FnRlE": {
        "detail_ref": "ZDE6VUJESHhaOE5jUHhFQjRBXzoxNDQ4OjA6OUVXLURBcE1LOTQ6YXBIRFQzU3FnRlE",
        "input": "{\"command\":\"cat missing-file.txt\",\"description\":\"Cat missing file (expected fail)\",\"working_directory\":\"/work/demo\"}",
        "truncated": false
      },
      "ZDE6VUJESHhaOE5jUHhFQjRBXzoxNzYyOjA6Qm9QZ0NDRlVqSU06dWVRLXA0eU5Nd0U": {
        "detail_ref": "ZDE6VUJESHhaOE5jUHhFQjRBXzoxNzYyOjA6Qm9QZ0NDRlVqSU06dWVRLXA0eU5Nd0U",
        "input": "{\"path\":\"/work/demo\",\"pattern\":\"hello\"}",
        "truncated": false
      }
    },
    "summary": {
      "items": [
        {
          "text": "Do these steps in order: 1) read note.txt, 2) append the line 'world' to note.txt, 3) run the shell command 'ls -la', 4) run the shell command 'cat missing-file.txt' (it will fail, that is expected), 5) search for the word hello in this folder. Then reply with one short sentence.",
          "type": "user"
        },
        {
          "text": "I'll follow the steps in order, starting by reading `note.txt`.",
          "type": "assistant"
        },
        {
          "detail_ref": "ZDE6VUJESHhaOE5jUHhFQjRBXzo0MzY6MTo0U2Z5OG1nazFHazozZ3A3OFpWT29rMA",
          "label": "/work/demo/note.txt",
          "name": "Read",
          "state": "done",
          "type": "tool"
        },
        {
          "text": "Appending `world` to `note.txt`, then running the remaining commands.",
          "type": "assistant"
        },
        {
          "detail_ref": "ZDE6VUJESHhaOE5jUHhFQjRBXzo3NTI6MTo5RVctREFwTUs5NDpLSXFjN1prcXQ3UQ",
          "label": "echo 'world' >> note.txt",
          "name": "Shell",
          "state": "done",
          "type": "tool"
        },
        {
          "detail_ref": "ZDE6VUJESHhaOE5jUHhFQjRBXzoxMTU3OjA6OUVXLURBcE1LOTQ6NXB1MTVoR0liVXc",
          "label": "ls -la",
          "name": "Shell",
          "state": "done",
          "type": "tool"
        },
        {
          "detail_ref": "ZDE6VUJESHhaOE5jUHhFQjRBXzoxNDQ4OjA6OUVXLURBcE1LOTQ6YXBIRFQzU3FnRlE",
          "label": "cat missing-file.txt",
          "name": "Shell",
          "state": "done",
          "type": "tool"
        },
        {
          "detail_ref": "ZDE6VUJESHhaOE5jUHhFQjRBXzoxNzYyOjA6Qm9QZ0NDRlVqSU06dWVRLXA0eU5Nd0U",
          "label": "hello",
          "name": "Grep",
          "state": "done",
          "type": "tool"
        },
        {
          "text": "All five steps completed: `note.txt` had hello, I appended world, listed the folder, `cat missing-file.txt` failed as expected, and hello is in `note.txt`.",
          "type": "assistant"
        }
      ],
      "next_cursor": null,
      "now": 1791161297829,
      "truncated": false
    }
  },
  "hermes": {
    "details": {
      "ZDE6OFo2SzdYamZEbThndVVERTo0OTY6MDpLcXowYU15anJKUTpOVVNLakVhaWlYYw": {
        "detail_ref": "ZDE6OFo2SzdYamZEbThndVVERTo0OTY6MDpLcXowYU15anJKUTpOVVNLakVhaWlYYw",
        "input": "{\"command\":\"ls -la\"}",
        "output": "total 8\ndrwxr-xr-x@  3 dev  wheel    96 Oct  5 08:25 .\ndrwx------@ 88 dev  wheel  2816 Oct  5 08:25 ..\n-rw-r--r--@  1 dev  wheel     6 Oct  5 08:25 note.txt",
        "truncated": false
      },
      "ZDE6OFo2SzdYamZEbThndVVERToxMjk2OjA6aTN3dzZiMXJ5bWs6RWo2TGlHRnJBZ0E": {
        "detail_ref": "ZDE6OFo2SzdYamZEbThndVVERToxMjk2OjA6aTN3dzZiMXJ5bWs6RWo2TGlHRnJBZ0E",
        "input": "{\"command\":\"cat missing-file.txt\"}",
        "output": "cat: missing-file.txt: No such file or directory",
        "truncated": false
      },
      "ZDE6OFo2SzdYamZEbThndVVERTozNjY6MDp5T2JLVG5HeFdabzpOc3Y5VTZJSkpScw": {
        "detail_ref": "ZDE6OFo2SzdYamZEbThndVVERTozNjY6MDp5T2JLVG5HeFdabzpOc3Y5VTZJSkpScw",
        "input": "{\"path\":\"note.txt\"}",
        "output": "{\"content\": \"1|hello\\n2|\", \"total_lines\": 1, \"file_size\": 6, \"truncated\": false, \"is_binary\": false, \"is_image\": false}",
        "truncated": false
      }
    },
    "summary": {
      "items": [
        {
          "at": 1791159957814,
          "text": "Do these steps in order: 1) read the file note.txt in the current directory, 2) run the shell command 'ls -la', 3) run the shell command 'cat missing-file.txt' (it will fail, that is expected). Then reply with one short sentence.",
          "type": "user"
        },
        {
          "at": 1791159961886,
          "text": "I'll start with the first two independent steps.",
          "type": "assistant"
        },
        {
          "at": 1791159961886,
          "detail_ref": "ZDE6OFo2SzdYamZEbThndVVERTozNjY6MDp5T2JLVG5HeFdabzpOc3Y5VTZJSkpScw",
          "label": "note.txt",
          "name": "read_file",
          "state": "done",
          "type": "tool"
        },
        {
          "at": 1791159961886,
          "detail_ref": "ZDE6OFo2SzdYamZEbThndVVERTo0OTY6MDpLcXowYU15anJKUTpOVVNLakVhaWlYYw",
          "label": "ls -la",
          "name": "terminal",
          "state": "done",
          "type": "tool"
        },
        {
          "at": 1791159966472,
          "text": "Now step 3.\n\nNote: read_file gave note.txt content \"hello\". ls shows only note.txt. Now cat missing-file.txt.",
          "type": "thinking"
        },
        {
          "at": 1791159966472,
          "detail_ref": "ZDE6OFo2SzdYamZEbThndVVERToxMjk2OjA6aTN3dzZiMXJ5bWs6RWo2TGlHRnJBZ0E",
          "label": "cat missing-file.txt",
          "name": "terminal",
          "state": "error",
          "type": "tool"
        },
        {
          "at": 1791159968467,
          "text": "note.txt 里是 \"hello\"，目录下也只有它，而 cat missing-file.txt 如期报 \"No such file or directory\"。",
          "type": "assistant"
        }
      ],
      "next_cursor": null,
      "now": 1791161297852,
      "truncated": false
    }
  },
  "opencode": {
    "details": {
      "ZDE6RlpLZHJtX3NfUjJpQTZuMTo0MzI6MDpvYmpGdVRzbl9WTTpKTTFXUWN5ZVNGYw": {
        "detail_ref": "ZDE6RlpLZHJtX3NfUjJpQTZuMTo0MzI6MDpvYmpGdVRzbl9WTTpKTTFXUWN5ZVNGYw",
        "input": "{\"filePath\":\"/work/demo/note.txt\"}",
        "output": "<file>\n00001| hello\n00002| \n\n(End of file - total 2 lines)\n</file>",
        "truncated": false
      },
      "ZDE6RlpLZHJtX3NfUjJpQTZuMTo3OTg6MDpBakVMbDduYnVUazpxU0tCOTh0eFFtTQ": {
        "detail_ref": "ZDE6RlpLZHJtX3NfUjJpQTZuMTo3OTg6MDpBakVMbDduYnVUazpxU0tCOTh0eFFtTQ",
        "input": "{\"command\":\"ls -la\",\"description\":\"List all files in directory\"}",
        "output": "total 8\ndrwxr-xr-x@  4 dev  wheel   128 Oct  5 08:26 .\ndrwx------@ 89 dev  wheel  2848 Oct  5 08:29 ..\ndrwxr-xr-x@  9 dev  wheel   288 Oct  5 08:26 .git\n-rw-r--r--@  1 dev  wheel     6 Oct  5 08:26 note.txt\n",
        "truncated": false
      },
      "ZDE6RlpLZHJtX3NfUjJpQTZuMToxMjE2OjA6VEdncVRteGNFcU06NDZRZ3RkY0I1QUE": {
        "detail_ref": "ZDE6RlpLZHJtX3NfUjJpQTZuMToxMjE2OjA6VEdncVRteGNFcU06NDZRZ3RkY0I1QUE",
        "input": "{\"command\":\"cat missing-file.txt\",\"description\":\"Attempt to cat missing file\"}",
        "output": "cat: missing-file.txt: No such file or directory\n",
        "truncated": false
      }
    },
    "summary": {
      "items": [
        {
          "at": 1791160146257,
          "text": "\"Do these steps in order: 1) read note.txt, 2) run the shell command 'ls -la', 3) run the shell command 'cat missing-file.txt' (it will fail, that is expected). Then reply with one short sentence.\"",
          "type": "user"
        },
        {
          "at": 1791160151037,
          "text": "The user wants me to do steps in order: read note.txt, run ls -la, run cat missing-file.txt, then reply with one short sentence. Let me do these.",
          "type": "thinking"
        },
        {
          "at": 1791160151738,
          "detail_ref": "ZDE6RlpLZHJtX3NfUjJpQTZuMTo0MzI6MDpvYmpGdVRzbl9WTTpKTTFXUWN5ZVNGYw",
          "label": "/work/demo/note.txt",
          "name": "read",
          "state": "done",
          "type": "tool"
        },
        {
          "at": 1791160151974,
          "detail_ref": "ZDE6RlpLZHJtX3NfUjJpQTZuMTo3OTg6MDpBakVMbDduYnVUazpxU0tCOTh0eFFtTQ",
          "label": "ls -la",
          "name": "bash",
          "state": "done",
          "type": "tool"
        },
        {
          "at": 1791160152198,
          "detail_ref": "ZDE6RlpLZHJtX3NfUjJpQTZuMToxMjE2OjA6VEdncVRteGNFcU06NDZRZ3RkY0I1QUE",
          "label": "cat missing-file.txt",
          "name": "bash",
          "state": "error",
          "type": "tool"
        },
        {
          "at": 1791160154770,
          "text": "Done: note.txt contains \"hello\", `ls -la` worked, and `cat missing-file.txt` failed as expected.",
          "type": "assistant"
        }
      ],
      "next_cursor": null,
      "now": 1791161297859,
      "truncated": false
    }
  }
};

/** view: the summary items a phone holds; backing: the same with each tool's body, for the fixture's detail read. */
export function recordedAgentSession(agent: RecordedAgent): { view: AgentTraceItem[]; backing: AgentTraceItem[] } {
  const view = parseAgentTraceSummaryPage(RECORDED[agent].summary).items;
  const backing = view.map((item) => {
    if (!item.detailRef) return item;
    const detail = parseAgentTraceDetail(RECORDED[agent].details[item.detailRef], item.detailRef);
    return { ...item, input: detail.input, output: detail.output };
  });
  return { view, backing };
}
