// Entry point. All the logic lives in app.js so it can be tested.
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 8080;

const app = createApp();
app.listen(PORT).then((port) => {
  console.log(`LoL Sound Quiz server listening on port ${port}`);
});

// Hosts stop containers with SIGTERM; close sockets cleanly so players get a
// clear "disconnected" instead of a hung connection.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
