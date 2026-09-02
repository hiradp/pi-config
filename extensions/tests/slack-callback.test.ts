import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer } from "node:net";
import { test } from "node:test";
import { isLoopbackAddress, receiveAuthorizationCode } from "../slack/oauth.ts";
import { SLACK_REDIRECT_URI } from "../slack/types.ts";

const redirect = new URL(SLACK_REDIRECT_URI);
const authorizationUrl = new URL("https://slack.com/oauth/v2_user/authorize?state=unused");
const expectedState = "expected-state";

type CallbackOptions = Parameters<typeof receiveAuthorizationCode>[0];

function receive(overrides: Partial<CallbackOptions> = {}): Promise<string> {
  return receiveAuthorizationCode({
    authorizationUrl,
    expectedState,
    timeoutMs: 2_000,
    signal: new AbortController().signal,
    openBrowser: async () => {},
    ...overrides,
  });
}

/** A browser stand-in whose requests run in the background so they can be awaited after the flow settles. */
function browserThat(run: () => Promise<void>): {
  open: () => Promise<void>;
  done: () => Promise<void>;
} {
  let pending: Promise<void> = Promise.resolve();
  return {
    open: async () => {
      pending = run();
    },
    done: () => pending,
  };
}

function send(
  path: string,
  options: { method?: string; host?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: redirect.hostname,
        port: Number(redirect.port),
        path,
        method: options.method ?? "GET",
        agent: false,
        headers: { Host: options.host ?? `${redirect.hostname}:${redirect.port}` },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function tryBind(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host: redirect.hostname, port: Number(redirect.port), exclusive: true }, () =>
      probe.close(() => resolve(true)),
    );
  });
}

async function assertPortReleased(): Promise<void> {
  // A pending listen() resolves localhost first, so let a leaked bind land before probing.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await tryBind()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the callback port stayed bound");
}

test("only the matching Slack redirect settles the login", async () => {
  const statuses: number[] = [];
  const strays: Array<[string, { method?: string; host?: string }]> = [
    ["/", {}],
    ["/callback", {}],
    [`/callback?state=stale&code=stale`, {}],
    [`/callback?state=${expectedState}&code=posted`, { method: "POST" }],
    [`/callback?state=${expectedState}&code=spoofed`, { host: "127.0.0.1:3118" }],
  ];
  const browser = browserThat(async () => {
    for (const [path, options] of strays) statuses.push((await send(path, options)).status);
    statuses.push((await send(`/callback?state=${expectedState}&code=real`)).status);
  });

  const code = await receive({ openBrowser: browser.open });
  await browser.done();

  assert.equal(code, "real");
  assert.deepEqual(statuses, [404, 400, 400, 400, 400, 200]);
});

test("a denied authorization with a matching state settles the login", async () => {
  let status: number | undefined;
  const browser = browserThat(async () => {
    status = (await send(`/callback?state=${expectedState}&error=access_denied`)).status;
  });

  await assert.rejects(receive({ openBrowser: browser.open }), /Slack authorization was denied/);
  await browser.done();
  assert.equal(status, 400);
});

test("a matching callback without a code settles the login", async () => {
  let status: number | undefined;
  const browser = browserThat(async () => {
    status = (await send(`/callback?state=${expectedState}`)).status;
  });

  await assert.rejects(receive({ openBrowser: browser.open }), /did not include a code/);
  await browser.done();
  assert.equal(status, 400);
});

test("the login times out when no callback arrives", async () => {
  await assert.rejects(receive({ timeoutMs: 50 }), /Slack login timed out/);
  await assertPortReleased();
});

test("cancelling while the callback server binds releases the port", async () => {
  const controller = new AbortController();
  const flow = receive({ signal: controller.signal });
  controller.abort();

  await assert.rejects(flow, /Slack login was cancelled/);
  await assertPortReleased();
});

test("the callback server is gone once the login has completed", async () => {
  const browser = browserThat(async () => {
    await send(`/callback?state=${expectedState}&code=first`);
  });

  const code = await receive({ openBrowser: browser.open });
  await browser.done();

  assert.equal(code, "first");
  await assert.rejects(send(`/callback?state=${expectedState}&code=second`));
});

test("only loopback peers may deliver the callback", () => {
  for (const address of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of [
    undefined,
    "",
    "10.0.0.8",
    "192.168.1.2",
    "::ffff:10.0.0.8",
    "::2",
    "fe80::1",
    "localhost",
  ]) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
});
