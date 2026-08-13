from pathlib import Path

path = Path('deploy/wobble-ops-helper.mjs')
text = path.read_text()
old = """      socket.setTimeout(0);
      let result;
      try {
"""
new = """      // The IPC boundary owns queued -> running. No privileged executor is called unless this
      // durable transition was committed first; injected/test executors follow the same contract.
      if (!transitionDurableOperation(begun.context, 'running')) {
        send(socket, {
          ok: false,
          reason: 'operation-state-failed',
          operationId: begun.context.id,
          requestId: request.requestId,
          action: request.action
        });
        return;
      }

      socket.setTimeout(0);
      let result;
      try {
"""
count = text.count(old)
if count != 1:
    raise SystemExit(f'expected one createServer running-boundary match, found {count}')
path.write_text(text.replace(old, new, 1))
