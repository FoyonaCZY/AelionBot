/**
 * What a model seat of Mahjong reads. Same outer shape as every game. The seat sees its own tiles, every river and
 * meld, and the request lists every legal move; each discard carries the tiles-from-ready and useful draws the
 * program worked out, which the table also shows people.
 */
import type { GameRequest, GameView } from '../../../shared/types/game-types';
import { tileName } from '../../../shared/games/mahjong-rules';
import { actionContract, TABLE_TALK_MAX } from './action-contract';
import { seatAliases } from './prompt-seats';

/** Only when the table has talk on: otherwise the model is never told it may speak. It follows the fixed rules, so
 * those stay the same prompt prefix either way. */
const TALK = `\n可选附 text：一句不超过 ${TABLE_TALK_MAX} 字的牌桌闲聊，像真人打麻将时随口说的话；没想说的就不附。text 会被所有玩家看到，绝不能透露或暗示你的手牌、听什么牌、还缺什么。`;

const RULES = `你在玩四人「麻将」（推倒胡）。136 张牌：万、条、筒各 1–9，加东南西北中发白，每种 4 张，没有花牌。每人 13 张，庄家先摸。
轮到你：摸一张后，自摸和牌、暗杠/加杠（补一张再继续），或打出一张。别人打出的牌，你可以和（点炮）、杠或碰；不能吃。和牌优先于碰杠；多人能和时按出牌者下家起的顺序，第一个人和。碰或杠后轮到你出牌。牌墙摸完无人和牌就是流局。
和牌：四组面子（顺子如 345 万、刻子如 777 条，碰和杠也算一组）加一对将；或七个不同的对子（七对，不能有碰杠）。
番：平胡 1，七对或碰碰胡 +2，混一色 +2，清一色 +4，字一色 +6，门清 +1，自摸 +1，杠上开花 +1，海底捞月/河底捞鱼 +1。点炮由出牌者付番数，自摸由其他三家各付番数。

怎么打：
- request.options 列出本轮所有合法选择，系统已经替你算好：每个「打 X」后面的 hint 是打掉它之后离听牌还差几步（向听数）和有效进张。一般优先打向听数最小、进张最多的牌，但也要看场面：别人碰了很多同一花色、某张牌已经打出多张，都会改变判断。
- 别人快听牌时（碰杠多、打出的牌变生），少打危险的生张，多打别人已经打过的熟张。
- 能和就考虑和；番数低时也可以继续做大，但要权衡被别人先和的风险。碰会让你失去门清，杠会给自己补牌也给对手看清信息。
- 只从 request.options 中选一个 id 作为 target；碰杠和的询问可以 {"skip":true} 表示过；轮到你出牌时不能 skip。

context.shared 是全员可见的公开信息，context.personal 是只有你能看到的信息（包括你的手牌）。yourSeat 是你的座位号，对外用座位号称呼别人。
每次 JSON 都附带 note：一两句说明这手的打算和依据。note 只出现在赛后记录里，不会给其他玩家看。context.personal.notes 是你本局此前的 note。仅返回 JSON，禁止代码块或额外文字。`;

const names = (tiles: string[]) => tiles.map(tileName).join(' ');

export function mahjongInstructions(_context: GameView, request: GameRequest) {
  return (
    RULES +
    (request.talk ? TALK : '') +
    '\n\n本轮只执行 ' +
    request.kind +
    (request.kind === 'claim' ? '（是否碰、杠或和别人打出的牌）' : '（你的回合）') +
    '。仅返回符合以下结构的 JSON：\n' +
    JSON.stringify(actionContract(request)) +
    '\n' +
    (request.canPass
      ? '要么只给 target（request.options 里某一项的 id），要么给 {"skip":true} 表示过。'
      : '必须给 target（request.options 里某一项的 id），不能 skip。')
  );
}

export function mahjongPrompt(context: GameView, request: GameRequest) {
  const self = context.seats.find((p) => p.id === request.seatId);
  if (!self) throw Error('缺少本人座位');
  const table = context.tiles!;
  const { aliases, alias } = seatAliases(context.seats);
  const seat = context.seats.indexOf(self) + 1;
  const name = (id: string) => aliases[context.seats.findIndex((p) => p.id === id)]?.name;
  return JSON.stringify({
    you: request.seatId,
    yourSeat: { seat, name: aliases[seat - 1].name, dealer: table.dealerId === self.id },
    context: {
      shared: {
        game: '麻将',
        logs: context.logs
          .filter((l) => l.scope === 'shared')
          .slice(-30)
          .map((l, i) => ({ id: i + 1, seatId: l.seatId, text: alias(l.text, !!l.seatId), source: 'public_event' })),
        seats: context.seats.map((p, i) => ({
          id: p.id,
          seat: i + 1,
          name: aliases[i].name,
          dealer: table.dealerId === p.id,
          tilesInHand: table.counts[p.id],
          melds: table.melds[p.id].map(
            (m) => `${m.kind === 'peng' ? '碰' : m.kind === 'gang' ? '明杠' : '暗杠'} ${tileName(m.tile)}`,
          ),
          discards: names(table.discards[p.id]),
        })),
        wallLeft: table.wall,
        ...(table.lastDiscard
          ? { lastDiscard: { by: name(table.lastDiscard.seatId), tile: tileName(table.lastDiscard.tile) } }
          : {}),
      },
      personal: {
        self: {
          id: self.id,
          hand: names(table.hand || []),
          ...(table.drawn ? { justDrew: tileName(table.drawn) } : {}),
          mbti: self.mbti,
          personality: self.personality,
          personalitySource: 'ai_game_preset',
        },
        ...(context.notes?.length ? { notes: context.notes.map((text) => alias(text, true)) } : {}),
      },
    },
    request: {
      seatId: request.seatId,
      kind: request.kind,
      canPass: !!request.canPass,
      options: (request.options || []).map((o) => ({ id: o.id, move: o.label, ...(o.hint ? { hint: o.hint } : {}) })),
      source: 'private_action_request',
    },
  });
}
