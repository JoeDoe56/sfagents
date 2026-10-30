/**
 * Emoji for reactions, in the system's own emoji font (Apple Color Emoji,
 * Segoe UI Emoji, Noto Color Emoji): no images, so they look native on
 * every device. The quick row is Messages' tapbacks as emoji.
 */

export const QUICK = ['❤️', '👍', '👎', '😂', '‼️', '❓', '😭'];

export const CATEGORIES = [
  {
    name: 'Smileys',
    list: '😀 😃 😄 😁 😆 🥹 😅 😂 🤣 🥲 ☺️ 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 🙂‍↕️ 😏 😒 🙂‍↔️ 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😮‍💨 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🫣 🤗 🫡 🤔 🫢 🤭 🤫 🤥 😶 😶‍🌫️ 😐 😑 😬 🫨 🫠 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 😵‍💫 🫥 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 👾 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾',
  },
  {
    name: 'Gestures',
    list: '👋 🤚 🖐️ ✋ 🖖 🫱 🫲 🫳 🫴 🫷 🫸 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 🫵 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🧠 🫀 👀 👁️ 👅 👄 🫦 💋',
  },
  {
    name: 'Hearts',
    list: '❤️ 🩷 🧡 💛 💚 💙 🩵 💜 🖤 🩶 🤍 🤎 ❤️‍🔥 ❤️‍🩹 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟',
  },
  {
    name: 'Animals & Nature',
    list: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐻‍❄️ 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🦖 🐙 🦑 🦀 🐡 🐠 🐬 🐳 🦈 🐊 🐘 🦒 🐕 🐈 🐓 🦜 🌵 🌲 🌴 🌱 🍀 🍁 🍄 🌸 🌹 🌻 🌞 🌝 🌚 🌙 ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ⛅ ☁️ 🌧️ ⛈️ ❄️ ☃️ 💧 🌊',
  },
  {
    name: 'Food & Drink',
    list: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🌶️ 🌽 🥕 🥐 🍞 🧀 🥚 🍳 🥓 🥞 🧇 🍗 🍖 🌭 🍔 🍟 🍕 🌮 🌯 🥗 🍝 🍜 🍣 🍱 🍤 🍙 🍦 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 🍿 ☕ 🍵 🧋 🥤 🍺 🍻 🥂 🍷 🍸 🍹 🧉',
  },
  {
    name: 'Activities',
    list: '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🏒 ⛳ 🏹 🎣 🥊 🛹 ⛷️ 🏂 🏋️ 🤸 🏄 🏊 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎟️ 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🕹️ 🧩 🎉 🎊 🎈 🎁',
  },
  {
    name: 'Travel & Objects',
    list: '🚗 🚕 🚙 🚌 🏎️ 🚓 🚑 🚒 🚚 🚜 🏍️ 🚲 🛴 ✈️ 🚀 🛸 🚁 ⛵ 🚢 ⚓ 🗺️ 🏠 🏡 🏢 🏰 🗽 🗼 ⛺ 🌋 🏔️ 🏖️ 🏝️ ⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 💿 📷 🎥 📺 📻 🔋 🔌 💡 🔦 🕯️ 💸 💵 💰 💳 💎 🔧 🔨 🛠️ ⚙️ 🧲 🔫 💣 🔪 🛡️ 🔮 💊 💉 🧬 🔬 🔭 🧹 🧺 🧻 🚽 🛁 🔑 🗝️ 🚪 🛋️ 🛏️ 🧸 🎀 ✉️ 📦 📝 📎 📌 📍 ✂️ 🔒 🔓',
  },
  {
    name: 'Symbols',
    list: '✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ♾️ ‼️ ⁉️ ❓ ❔ ❗ ❕ 〰️ 💯 🔞 📵 🚫 ⛔ ⭕ 🛑 ⚠️ 🚸 ♻️ ⚜️ 🔱 📛 🔰 ✳️ ❇️ 💤 💢 💬 💭 🗯️ 💥 💫 💦 💨 🕳️ 🎵 🎶 🔔 🔕 📣 📢 🆗 🆕 🆒 🆓 🆙 🆘 🔝 🔜 ⏰ ⌛ ⏳ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🔺 🔻 🔸 🔹 🏁 🚩 🏳️ 🏴 🏳️‍🌈 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 #️⃣ *️⃣',
  },
].map((c) => ({ name: c.name, list: c.list.split(' ') }));

/** Whether a string is a single emoji (what a reaction may be). */
export function isEmoji(text) {
  if (!text || text.length > 32) return false;
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)] : [text];
  if (seg.length !== 1) return false;
  const keycapsOut = text.replace(/[#*0-9]️?⃣/gu, '⬛');
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(keycapsOut) && !/[\p{L}\p{N}\s]/u.test(keycapsOut);
}

/** The last emoji typed into a field (for the "any emoji" field, fed by the OS emoji panel). */
export function lastEmoji(text) {
  if (!text) return null;
  const parts = typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment) : [...text];
  for (let i = parts.length - 1; i >= 0; i--) if (isEmoji(parts[i])) return parts[i];
  return null;
}
