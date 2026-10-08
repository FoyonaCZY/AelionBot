import test from 'node:test';
import assert from 'node:assert/strict';
import { gameProviders } from '../electron/core/games/providers';
import { textTokens } from '../electron/core/context/context-budget';
import { createWerewolf, view } from '../electron/core/games/werewolf';
const registry = (maxOutputTokens?: number) =>
  gameProviders({
    baseUrl: 'https://grok.invalid/v1',
    model: 'grok-test',
    apiKey: 'secret-grok',
    maxOutputTokens,
    additionalProviders: [
      {
        id: 'mimo-game',
        name: 'MiMo',
        model: 'mimo-v2.6-pro',
        baseUrl: 'https://mimo.invalid/v1',
        apiKey: 'secret-mimo',
        backend: 'chat-completions',
        maxOutputTokens,
      },
    ],
  });
const players = Array.from({ length: 12 }, (_, i) => ({
  id: String(i),
  name: '玩家' + i,
  human: false,
  color: '#888',
}));
test('provider selection survives normalization and public config contains no secrets', () => {
  const r = registry(),
    p = { ...players[0], model: { providerId: 'mimo-game', model: 'mimo-v2.6-pro', contextTokens: 32768 } };
  assert.equal(r.normalize(p).model?.providerId, 'mimo-game');
  assert.equal(r.normalize(players[1]).model?.providerId, 'grok-game');
  assert(!JSON.stringify(r.publicConfig).includes('secret'));
  assert.equal(r.publicConfig.providers.length, 2);
  assert.throws(() => r.normalize({ ...p, model: { ...p.model, model: 'unknown' } }));
});
test('mixed players use their own endpoint, key and response parser', async () => {
  const r = registry(),
    s = createWerewolf('test', players, undefined, 'guard12'),
    request = s.requests[0],
    context = view(s, request.seatId);
  const original = globalThis.fetch;
  try {
    for (const mimo of [true, false]) {
      let captured:
        Parameters<NonNullable<import('../electron/core/games/runtime').DecisionOptions['onRequest']>>[0] | undefined;
      globalThis.fetch = async (input, init) => {
        assert.equal(
          String(input),
          mimo ? 'https://mimo.invalid/v1/chat/completions' : 'https://grok.invalid/v1/responses',
        );
        assert.equal((init!.headers as any).Authorization, 'Bearer secret-' + (mimo ? 'mimo' : 'grok'));
        const body = JSON.parse(init!.body as string),
          output = mimo ? body.max_completion_tokens : body.max_output_tokens,
          prompt = mimo
            ? body.messages.map((message: { content: string }) => message.content).join('')
            : body.instructions + body.input,
          capacity = r.publicConfig.providers.find((provider) => provider.id === (mimo ? 'mimo-game' : 'grok-game'))!
            .models[0].contextTokens;
        assert.equal(captured?.instruction, mimo ? body.messages[0].content : body.instructions);
        assert.equal(captured?.input, mimo ? body.messages[1].content : body.input);
        assert.equal(captured?.config.maxOutputTokens, output);
        assert.equal(captured?.config.model, body.model);
        assert(!JSON.stringify(captured).includes('secret-'), 'game request contains no credentials');
        assert(!JSON.stringify(captured).includes('.invalid'), 'game request contains no provider address');
        assert.equal(capacity, 32768);
        assert.ok(output > 4096);
        assert.ok(
          textTokens(prompt) + output < capacity,
          'default output budget must fit the advertised context capacity with input and safety room',
        );
        if (mimo) {
          assert(body.messages[0].content.includes('你是MiMo'));
          assert(body.messages[0].content.includes('守卫'));
          assert.equal(body.stream, false);
        } else assert(body.instructions);
        return new Response(
          JSON.stringify(
            mimo
              ? { choices: [{ message: { content: '{"skip":true}', reasoning_content: 'not an action' } }] }
              : { output_text: '{"skip":true}' },
          ),
        );
      };
      const p = {
        ...players[0],
        model: {
          providerId: mimo ? 'mimo-game' : 'grok-game',
          model: mimo ? 'mimo-v2.6-pro' : 'grok-test',
          contextTokens: 32768,
        },
      };
      assert.equal(
        (
          await r.decide(p, context, request, new AbortController().signal, {
            onResponse() {},
            onRequest: (value) => {
              captured = value;
            },
          })
        ).skip,
        true,
      );
    }
    const limited = registry(1234);
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(init!.body as string);
      assert.equal(body.max_output_tokens, 1234);
      return new Response(JSON.stringify({ output_text: '{"skip":true}' }));
    };
    const player = { ...players[0], model: { providerId: 'grok-game', model: 'grok-test', contextTokens: 32768 } };
    assert.equal((await limited.decide(player, context, request, new AbortController().signal)).skip, true);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { output_tokens: 1234, output_tokens_details: { reasoning_tokens: 1200 } },
        }),
      );
    await assert.rejects(() => limited.decide(player, context, request, new AbortController().signal), {
      code: 'format',
      reason: 'game.output_truncated',
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('transport errors explain DNS/connection failures without leaking raw errors or keys', async () => {
  const original = globalThis.fetch;
  const s = createWerewolf('network-test', players, undefined, 'guard12');
  const request = s.requests[0];
  try {
    for (const [code, reason, message] of [
      ['ENOTFOUND', 'game.dns_failed', '域名解析失败'],
      ['EAI_AGAIN', 'game.dns_failed', '域名解析失败'],
      ['ECONNREFUSED', 'game.connection_refused', '拒绝连接'],
      ['UND_ERR_CONNECT_TIMEOUT', 'game.connection_timeout', '超时'],
      ['CERT_HAS_EXPIRED', 'game.tls_failed', '证书校验失败'],
      ['UNKNOWN', 'game.network_failed', '无法连接'],
    ]) {
      globalThis.fetch = async () => {
        throw new TypeError('secret-key https://private.invalid', { cause: { code } });
      };
      await assert.rejects(
        registry().decide(players[0], view(s, request.seatId), request, new AbortController().signal),
        (error: any) => {
          assert.equal(error.reason, reason);
          assert.equal(error.code, 'network');
          assert.ok(error.message.includes(message));
          assert.ok(!error.message.includes('secret'));
          assert.ok(!error.message.includes('private.invalid'));
          return true;
        },
      );
    }
    const timeout = new DOMException('timed out', 'TimeoutError');
    globalThis.fetch = async () => {
      throw timeout;
    };
    await assert.rejects(
      registry().decide(players[0], view(s, request.seatId), request, new AbortController().signal),
      (error) => error === timeout,
    );
    const controller = new AbortController();
    controller.abort();
    const aborted = new DOMException('cancelled', 'AbortError');
    globalThis.fetch = async () => {
      throw aborted;
    };
    await assert.rejects(
      registry().decide(players[0], view(s, request.seatId), request, controller.signal),
      (error) => error === aborted,
    );
  } finally {
    globalThis.fetch = original;
  }
});
