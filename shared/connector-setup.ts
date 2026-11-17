// What the add-connector dialog works out for platforms set up by hand: Discord's invite link from the token the
// person pasted, and the manifest a Slack app is created from.

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function fromBase64(value: string) {
  let bits = 0,
    count = 0,
    out = '';
  for (const char of value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')) {
    const index = BASE64.indexOf(char);
    if (index < 0) return '';
    bits = ((bits << 6) | index) & 0xffff;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out += String.fromCharCode((bits >> count) & 0xff);
    }
  }
  return out;
}

/**
 * The link that adds a Discord bot to a server, or '' while the text is not a bot token. A bot token starts with
 * the bot's ID in base64, which is also its application ID. The link asks for no permissions: sharing a server is
 * only what lets a person open a private chat with the bot.
 */
export function discordInviteUrl(token: string) {
  const parts = token.trim().split('.'),
    id = parts.length === 3 ? fromBase64(parts[0]) : '';
  return /^\d{15,22}$/.test(id) ? `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=0` : '';
}

/**
 * The manifest of a Slack app that talks to AelionBot: Socket Mode, direct messages in its Messages tab, buttons, and
 * the scopes to send text and files, read the files people send, react while working and read a sender's name.
 */
export function slackManifest(botName: string) {
  const name = botName.replace(/\s+/g, ' ').trim();
  return JSON.stringify(
    {
      // Slack takes up to 35 characters here.
      display_information: { name: name && Array.from(name).length <= 35 ? name : 'AelionBot' },
      features: {
        app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
        // Lowercase letters, digits and - _ . only; the name above is what people see.
        bot_user: { display_name: 'aelionbot', always_online: true },
      },
      oauth_config: {
        scopes: {
          bot: ['chat:write', 'im:history', 'im:write', 'files:read', 'files:write', 'reactions:write', 'users:read'],
        },
      },
      settings: {
        event_subscriptions: { bot_events: ['message.im'] },
        interactivity: { is_enabled: true },
        org_deploy_enabled: false,
        socket_mode_enabled: true,
        token_rotation_enabled: false,
      },
    },
    null,
    2,
  );
}
