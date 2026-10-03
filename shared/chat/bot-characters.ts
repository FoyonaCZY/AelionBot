/**
 * Character avatars: the Bot's own face and slanted eyes in costume. Each one is an original design that borrows a
 * familiar archetype's signature hair, accessory or colours; none copies a specific character or uses its name.
 * Artwork lives in src/bots/bot-character-art.ts; this list is what storage and IPC validate against.
 */
export type BotCharacterCategory = 'anime' | 'screen' | 'job' | 'fantasy';
export interface BotCharacter {
  id: string;
  name: string;
  category: BotCharacterCategory;
  /** The Bot's accent colour while the character is worn (names, highlights, older versions' plain avatar). */
  color: string;
}
export const BOT_CHARACTER_CATEGORIES: Record<BotCharacterCategory, string> = {
  anime: '动漫',
  screen: '影视',
  job: '职业',
  fantasy: '奇幻与萌物',
};
export const BOT_CHARACTERS: readonly BotCharacter[] = [
  { id: 'silver-witch', name: '银发魔女', category: 'anime', color: '#5fae8f' },
  { id: 'straw-captain', name: '草帽船长', category: 'anime', color: '#d94b3d' },
  { id: 'fox-ninja', name: '狐火忍者', category: 'anime', color: '#ef8a2a' },
  { id: 'golden-fighter', name: '金发战士', category: 'anime', color: '#d9a21b' },
  { id: 'twin-tail-diva', name: '双马尾歌姬', category: 'anime', color: '#2fb5aa' },
  { id: 'cat-girl', name: '猫耳少女', category: 'anime', color: '#e284a6' },
  { id: 'green-swordsman', name: '绿发剑士', category: 'anime', color: '#3f8f5b' },
  { id: 'moon-magician', name: '月光魔法少女', category: 'anime', color: '#e2799f' },
  { id: 'blue-pilot', name: '蓝发驾驶员', category: 'anime', color: '#5d8fc9' },
  { id: 'spark-mouse', name: '电气鼠', category: 'anime', color: '#e0ad00' },
  { id: 'pocket-cat', name: '口袋机器猫', category: 'anime', color: '#1e8fd6' },
  { id: 'forest-spirit', name: '森林大毛球', category: 'anime', color: '#6f7d8c' },
  { id: 'masked-spirit', name: '面具幽灵', category: 'anime', color: '#6c5a82' },
  { id: 'sakura-girl', name: '樱花少女', category: 'anime', color: '#d9759a' },
  { id: 'goggle-helper', name: '护目镜小黄人', category: 'screen', color: '#d7b316' },
  { id: 'pipe-detective', name: '烟斗侦探', category: 'screen', color: '#8f7048' },
  { id: 'glasses-wizard', name: '眼镜魔法学徒', category: 'screen', color: '#a33a3a' },
  { id: 'dark-knight', name: '黑盔骑士', category: 'screen', color: '#b8433a' },
  { id: 'armor-hero', name: '红金战甲', category: 'screen', color: '#c8323a' },
  { id: 'web-hero', name: '蛛网侠客', category: 'screen', color: '#cf3b3b' },
  { id: 'night-guardian', name: '暗夜守护者', category: 'screen', color: '#4a5263' },
  { id: 'sea-pirate', name: '海盗船长', category: 'screen', color: '#8a5a3c' },
  { id: 'green-alien', name: '绿色外星人', category: 'screen', color: '#5fae3a' },
  { id: 'astronaut', name: '宇航员', category: 'job', color: '#5a7fae' },
  { id: 'chef', name: '主厨', category: 'job', color: '#d65a4c' },
  { id: 'doctor', name: '医生', category: 'job', color: '#3f9a98' },
  { id: 'cowboy', name: '牛仔', category: 'job', color: '#b06a3b' },
  { id: 'firefighter', name: '消防员', category: 'job', color: '#d9482b' },
  { id: 'rock-star', name: '摇滚明星', category: 'job', color: '#d6457c' },
  { id: 'cyber-hacker', name: '赛博骇客', category: 'job', color: '#14a9a1' },
  { id: 'maid', name: '女仆', category: 'job', color: '#6b5a8e' },
  { id: 'samurai', name: '武士', category: 'job', color: '#5b4a8a' },
  { id: 'vampire', name: '吸血伯爵', category: 'fantasy', color: '#8e1f2f' },
  { id: 'forest-elf', name: '精灵弓手', category: 'fantasy', color: '#5f9a52' },
  { id: 'panda', name: '熊猫', category: 'fantasy', color: '#4a4552' },
  { id: 'santa', name: '圣诞老人', category: 'fantasy', color: '#d6403a' },
];
const ids = new Set(BOT_CHARACTERS.map((character) => character.id));
export const isBotCharacterId = (value: unknown): value is string => typeof value === 'string' && ids.has(value);
export const botCharacter = (id: string) => BOT_CHARACTERS.find((character) => character.id === id);
