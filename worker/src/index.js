// Cloudflare Worker: proxy for Vertex AI image generation, tuned to
// produce a 3×3 grid of LINE-sticker style images of the same character.
//
// Frontend calls us with { imageBase64, mimeType, phrases?, styleHint? }.
// We add the API key (Worker Secret) and forward to Vertex AI, then
// return the generated image as base64. Frontend splits the 3×3 grid
// into 9 sticker tiles, runs optional client-side background removal,
// and packages a LINE Creators Market ZIP.

const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";
const MAX_INPUT_BYTES = 10 * 1024 * 1024; // 10 MB decoded image

// Daily AI-generation quota per client IP. Tweak freely — only place to
// change it. Counter resets at UTC midnight. Bumped from 3 → 5 because
// Taiwan carriers share IPs via CGNAT, so 3 was too tight in practice.
const DAILY_LIMIT = 5;

// Cloudflare Turnstile site key — public, safe to expose. Frontend reads
// this via GET /config so we don't hardcode it twice. Pair this with
// the TURNSTILE_SECRET wrangler secret.
const TURNSTILE_SITE_KEY = "0x4AAAAAADFiwIJdu3HaPU_F";

// Default Traditional-Chinese short phrases commonly used on LINE.
// Frontend can override with its own phrase list. We keep ~50 here so
// frontend can pick 9 random ones per request without dupes.
const DEFAULT_PHRASES = [
  "哈囉", "嗨", "早安", "午安", "晚安", "謝謝", "OK", "收到", "好的", "加油",
  "笑死", "拜託", "對不起", "沒關係", "在嗎", "等等", "我來了", "想你", "愛你", "比心",
  "加班中", "好餓", "想睡", "累了", "開心", "生氣", "哭哭", "害羞", "驚訝", "收工",
  "掰掰", "太棒了", "真的嗎", "衝啊", "知道了", "安安", "嘿嘿", "嗯嗯", "晚點聊", "辛苦了",
  "厲害", "可愛", "認真", "再見", "歐買尬", "跪了", "抱抱", "啾", "嘔嘔嘔", "不要",
];

// Loose pool of expressive actions/poses paired with phrases. Worker
// chooses a sensible action when frontend doesn't dictate one.
const ACTION_FOR_PHRASE = {
  "哈囉": "smiling and waving one hand high",
  "嗨": "waving with a cheerful grin",
  "早安": "stretching arms up just woken, sleepy smile",
  "午安": "holding a mug of coffee, relaxed pose",
  "晚安": "yawning with eyes half-closed, hand near mouth",
  "謝謝": "bowing with hands together in thanks",
  "OK": "making an OK sign with thumb and finger, confident smile",
  "收到": "saluting with a hand near forehead, sharp expression",
  "好的": "thumbs up with a bright smile",
  "加油": "fist pumped in the air, determined look",
  "笑死": "laughing hysterically, head thrown back",
  "拜託": "hands clasped pleading, puppy eyes",
  "對不起": "head down apologetic, hands clasped together",
  "沒關係": "shrugging with an easy smile, palms open",
  "在嗎": "leaning forward squinting, finger to chin curious",
  "等等": "one palm forward in a STOP gesture, alarmed face",
  "我來了": "running forward arms back, hair flying",
  "想你": "head tilted, hand on cheek, dreamy eyes",
  "愛你": "blowing a kiss with one hand, hearts in eyes",
  "比心": "making a finger heart with both hands",
  "加班中": "exhausted at a laptop, dark circles under eyes",
  "好餓": "holding stomach, drooling, hungry face",
  "想睡": "rubbing eyes drowsily, head drooping",
  "累了": "slumped shoulders, defeated face",
  "開心": "jumping in the air arms wide, huge smile",
  "生氣": "puffed cheeks red face, fists clenched",
  "哭哭": "tears streaming, mouth open wailing",
  "害羞": "blushing hard, hands covering face partially",
  "驚訝": "eyes huge, mouth wide open in shock",
  "收工": "wiping forehead, satisfied look, arms stretched",
  "掰掰": "waving goodbye with a soft smile",
  "太棒了": "double thumbs up, sparkling eyes",
  "真的嗎": "wide eyes, hands on cheeks in disbelief",
  "衝啊": "fist out punching forward, fired up",
  "知道了": "nodding firmly, slight serious smile",
  "安安": "small wave at chest level, gentle smile",
  "嘿嘿": "mischievous grin, eyes squinted slyly",
  "嗯嗯": "nodding with eyes closed, agreeable face",
  "晚點聊": "checking watch, polite smile",
  "辛苦了": "patting own shoulder, warm smile",
  "厲害": "clapping hands enthusiastically",
  "可愛": "cheek squish with hands, sparkly eyes",
  "認真": "wearing a serious expression, finger pointed up",
  "再見": "waving with both hands, sad smile",
  "歐買尬": "hands on top of head, jaw dropped",
  "跪了": "kneeling on the ground, defeated",
  "抱抱": "arms wide open inviting a hug",
  "啾": "puckered lips kiss, one eye winked",
  "嘔嘔嘔": "covering mouth, looking nauseated green-faced",
  "不要": "arms crossed in an X, frowning hard",
};

// LINE Creators Market themed-campaign presets. Source of truth lives
// in `./campaigns.json` so a GitHub Action can append new entries via
// PR without touching JS. Each campaign overrides the relevant prompt
// knobs and injects a CAMPAIGN REQUIREMENT block into the assembled
// prompt so Gemini's 8/9 tiles align with LINE's editorial team's brief.
//
// Frontend reads this via GET /campaigns; expired entries are flagged
// but kept in the list (frontend decides how to display them).
import CAMPAIGNS from "./campaigns.json";

function campaignsManifest() {
  return CAMPAIGNS.map((c) => ({
    id: c.id,
    label: c.label,
    fullName: c.fullName,
    submitTag: c.submitTag,
    submitDeadline: c.submitDeadline,
    bannerPeriod: c.bannerPeriod,
    articleUrl: c.articleUrl,
    blurb: c.blurb,
    forceWithText: c.forceWithText,
    forceStyleHint: c.forceStyleHint,
  }));
}

function campaignById(id) {
  return CAMPAIGNS.find((c) => c.id === id) || null;
}

// Visual style presets — curated from catime's style_library.json
// (~174 styles) selecting ones that work well for LINE sticker art:
// preserves face / expressive / not too distorted.
//
// Frontend may also pass a `styleHint` that's NOT in this dict — in
// that case we treat the value as a raw English style description and
// inject it as-is. Lets users type custom styles like "90s anime + neon
// pastel pop art" without us pre-defining them.
const STYLE_PRESETS = {
  // === Default / Meta ===
  match: "Match the reference image's exact art style — keep the same drawing technique, line weight, color palette, and rendering. If the reference is a photo, output photo-style stickers; if anime, anime; if 3D, 3D.",

  // === Photo styles ===
  street_photography: "street photography, candid shot, natural light, urban setting, shallow depth of field, sharp focus on subject",
  dslr_portrait: "DSLR portrait, 85mm f/1.4 lens, creamy bokeh background, sharp focus on subject's eyes, professional studio look",
  film_35mm: "35mm film photography, grain, warm color cast, slight light leaks, vintage analogue feel",
  polaroid: "Polaroid instant film aesthetic, slightly faded colors, soft vignette, square frame look",
  studio_portrait: "studio portrait, clean key light + fill, neutral grey backdrop replaced with our keying green, sharp expression-focused composition",
  fashion_editorial: "high-fashion editorial photography, dramatic poses, magazine-quality lighting, glossy color grading",
  disposable_camera: "disposable film camera aesthetic, slight overexposure, flash glare, casual snapshot feel, 90s nostalgia",
  film_90s: "1990s film aesthetic, washed pastel tones, soft grain, vintage Asian magazine vibe",

  // === Painting / illustration ===
  watercolor: "soft watercolor painting, gentle washes of color, light pencil-like outlines, hand-painted feel, dreamy and warm",
  oil_painting: "oil painting, thick impasto brushstrokes, rich color palette, visible canvas texture",
  gouache: "gouache illustration, opaque matte paint, smooth flat areas with subtle brush texture",
  pencil_sketch: "pencil sketch, graphite on paper, hatching and cross-hatching, visible pencil strokes, traditional draftsman feel",
  colored_pencil: "colored pencil drawing, layered strokes, soft texture, warm hand-illustrated charm",
  chinese_ink: "Chinese ink wash painting, expressive brush strokes, minimal color, calligraphic quality, traditional East-Asian brush technique",
  ukiyoe: "Japanese woodblock print, flat color blocks, thick black outlines, traditional decorative patterns",
  impressionism: "impressionist painting, visible loose brush strokes, capture of light and color over detail, soft outdoor atmosphere",
  pop_art: "pop-art style, bold flat saturated colors, halftone dots, thick black outlines, mid-century commercial poster vibe",
  art_nouveau: "Art Nouveau illustration, ornate flowing lines, decorative botanical motifs, elegant 1900s decorative style",
  film_noir: "film noir aesthetic, high contrast black and white, dramatic shadows, smoky moody atmosphere",
  caricature: "caricature illustration, exaggerated key features, bold expression, comic portrait style",
  silhouette: "silhouette art, simple solid black/dark forms against bright background, strong shape recognition",

  // === Cartoon / anime ===
  manga: "Japanese manga style, dynamic linework, screentone shading, expressive eyes, black and white with selective color accents",
  soft_anime: "soft hand-drawn anime feature-film aesthetic, watercolor backgrounds, gentle nostalgic atmosphere, warm pastoral lighting",
  hyperreal_anime: "hyperrealistic anime style, semi-realistic proportions, detailed shading, vibrant glossy eyes",
  cel_shading: "cel-shaded animation, hard-edged shadows, flat color zones, classic 2D anime look",
  cute_chibi: "cute chibi sticker style: oversized head, small body, big sparkling eyes, simplified rounded shapes, soft pastel palette",
  bold_outline: "bold cartoon sticker style: thick black outlines, flat saturated colors, simple shapes, expressive faces, classic chat-sticker readability",
  flat_vector: "flat vector illustration, geometric shapes, no gradients, modern editorial style",
  doodle_line: "minimalist doodle line art, single-weight black outlines, ultra-clean simplification, almost icon-like",
  crayon: "crayon children's drawing aesthetic, wobbly waxy lines, scribbled fills, playful imperfect charm",

  // === 3D / craft ===
  polished_3d: "polished 3D character animation, smooth CG rendering, expressive features, warm soft global illumination, feature-film 3D animation aesthetic",
  blind_box_3d: "3D collectible-figure aesthetic, polished plastic surface, big-head proportions, designer-toy look",
  claymation: "stop-motion clay animation, sculpted clay character, visible fingerprint texture, handmade tactile charm",
  pixel_art: "16-bit pixel art, chunky pixels, limited retro palette, no anti-aliasing, classic retro game sprite feel",

  // === Trendy / niche ===
  cyberpunk: "cyberpunk aesthetic, neon-soaked night city, holographic elements, high-tech low-life mood",
  vaporwave: "vaporwave aesthetic, pink and teal pastel palette, glitchy retro 80s/90s elements, dreamy nostalgia",
  y2k: "Y2K aesthetic, chrome shiny metallic gradients, glossy bubble shapes, frosted plastic feel, early 2000s tech vibe",
  steampunk: "steampunk Victorian retro-futurism, brass gears, leather, copper pipes, ornate mechanical details",

  // === Generic chat-sticker DNA — original / no brand references ===
  classic_messenger_sticker: "classic chat-app messenger sticker aesthetic: thick clean black outline, flat saturated cute colors, simplified rounded character with big expressive eyes, soft drop shadow, friendly pop-up sticker pack readability — entirely original character, not imitating any specific brand.",
  pastel_kawaii: "minimal pastel kawaii style: thin delicate outlines, very soft pastel pink/pearl/mint palette, simplified facial features (small mouth, dot eyes), clean cute simplicity — entirely original design, no brand mascots.",
  webcomic_lineart: "modern webcomic lineart sticker style: light airy clean linework, soft cheek blush, expressive bright eyes, gentle pastel shading.",
  loose_handdrawn_doodle: "loose hand-drawn personal-doodle sticker style: relaxed wobbly lines, plain solid fills, simple character with relatable daily-life expression — original character, not imitating any published illustrator's mascot.",
  shitpost: "shitpost style: deliberately ugly-cute, asymmetric features, lazy drawing energy, like 5-second sketches that go viral exactly because they're so badly drawn.",
  retro_emoticon: "retro early-2000s messenger emoticon style: round yellow/peach face, simple dot eyes + curve mouth, glossy bubble look, nostalgic early-internet feel — generic round face, no specific app icon.",
  jelly_blob: "jelly-blob plush sticker style: glossy translucent gelatinous original character, soft 3D round form with light-reflection highlights, dewy candy aesthetic — fully original creature design.",
  glitter_sparkle: "Gen-Z glitter / sparkle aesthetic: shimmery rainbow pastel halftone backgrounds, sparkles around the character, holographic decoration, iridescent sticker-bomb energy.",
  black_marker: "black-marker zine style: hand-drawn with thick chunky black marker, cross-hatched shading, white correction-pen highlights, photocopy-zine aesthetic, 90s underground cool.",

  // === Special / meta ===
  meme_template: "Classic internet meme / reaction-image style: keep the reference character but exaggerate the facial expression to peak meme energy. Any text on the sticker is rendered in BOLD IMPACT-style font, all caps when Latin, white fill with hard black outline, hugging the top or bottom edge of the cell.",
  hand_drawn: "Loose hand-drawn marker doodle style: wobbly lines, casual sketchy fills, looks like it was scribbled on a napkin in 30 seconds.",
};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Build a manifest of the default phrase pool with stable ids.
// Frontend uses these ids to pin specific phrases to specific slots.
function phrasesManifest() {
  return DEFAULT_PHRASES.map((label, id) => ({ id, label }));
}

// Resolve a per-slot config (length 0..9) into a length-9 array of
// { phrase, action? } objects.
//
// Each input slot can be:
//   null                                     → random pick (no action override)
//   { phraseId: N, action? }                 → DEFAULT_PHRASES[N], optional action override
//   { phraseCustom: "...", action? }         → free text, optional action description
// Slots beyond the user's array are treated as null (random).
// `phrases` (flat array) is a backward-compat fallback equivalent to N
// custom-phrase slots padded with nulls.
//
// `action` (when present) is a free-form English pose/expression description
// that overrides the ACTION_FOR_PHRASE map. AI theme generator can produce
// {phrase, action} pairs so withText=false stickers still get correct poses.
function pickNineSlots({ slots, phrases, campaign }) {
  // Decide the pool used to fill un-pinned slots:
  //   campaign.phrasePoolOverride > user's `phrases` array > DEFAULT_PHRASES
  const camp = campaign ? campaignById(campaign) : null;
  const fallbackPool =
    (camp && Array.isArray(camp.phrasePoolOverride) && camp.phrasePoolOverride) ||
    (Array.isArray(phrases) && phrases.length > 0
      ? phrases.map((p) => String(p || "").trim()).filter(Boolean)
      : null) ||
    DEFAULT_PHRASES;

  // Backward-compat: no slots, only flat phrases pool — random draw 9.
  if (!Array.isArray(slots) && fallbackPool !== DEFAULT_PHRASES) {
    const picked = fallbackPool.length >= 9
      ? shuffle(fallbackPool).slice(0, 9)
      : shuffle(
          fallbackPool.concat(
            shuffle(DEFAULT_PHRASES.filter((d) => !fallbackPool.includes(d)))
              .slice(0, 9 - fallbackPool.length)
          )
        );
    return picked.map((phrase) => ({ phrase }));
  }

  const result = new Array(9).fill(null);
  const used = new Set();
  const slotArr = Array.isArray(slots) ? slots : [];

  // Pass 1: fill explicit pins (slot pins ALWAYS win, even over campaign pool).
  for (let i = 0; i < 9; i++) {
    const slot = slotArr[i];
    if (!slot) continue;
    const action =
      typeof slot.action === "string" && slot.action.trim()
        ? slot.action.trim()
        : undefined;
    if (typeof slot.phraseCustom === "string" && slot.phraseCustom.trim()) {
      const t = slot.phraseCustom.trim();
      result[i] = { phrase: t, action };
      used.add(t);
    } else if (
      Number.isInteger(slot.phraseId) &&
      slot.phraseId >= 0 &&
      slot.phraseId < DEFAULT_PHRASES.length
    ) {
      const t = DEFAULT_PHRASES[slot.phraseId];
      result[i] = { phrase: t, action };
      used.add(t);
    }
  }

  // Pass 2: fill nulls with random non-used picks from the chosen pool.
  const remaining = shuffle(fallbackPool.filter((p) => !used.has(p)));
  for (let i = 0; i < 9; i++) {
    if (result[i] === null) {
      const phrase =
        remaining.pop() ||
        fallbackPool[Math.floor(Math.random() * fallbackPool.length)];
      result[i] = { phrase };
    }
  }
  return result;
}

function actionFor(slot) {
  if (slot && typeof slot.action === "string" && slot.action.trim()) {
    return slot.action.trim();
  }
  const phrase = slot && slot.phrase;
  return ACTION_FOR_PHRASE[phrase]
    || "expressive sticker pose appropriate for the phrase";
}

// IMPORTANT: pass `nine` in pre-computed by the caller (NOT internally
// derived) — pickNineSlots is non-deterministic (Math.random + shuffle),
// so calling it twice in one request yields TWO different sets. The
// prompt and the response MUST share the same nine phrases.
//
// `nine` shape: array of length 9, each element { phrase: string, action?: string }.
function buildPrompt({ nine, styleHint, withText, campaign, lang }) {
  const camp = campaign ? campaignById(campaign) : null;
  // Campaign forces win over user input.
  const effectiveStyle = (camp && camp.forceStyleHint) || styleHint;
  const effectiveWithText =
    camp && camp.forceWithText !== null && camp.forceWithText !== undefined
      ? camp.forceWithText
      : withText;
  if (!Array.isArray(nine) || nine.length !== 9) {
    throw new Error("buildPrompt: `nine` must be a length-9 array");
  }
  // styleHint can be a preset key (looked up in STYLE_PRESETS) OR a free-form
  // description (any language, used as-is). Anything ≥ 2 chars not in dict
  // = treat as custom user input. Frontend already validates ≥ 2 too.
  let style;
  if (STYLE_PRESETS[effectiveStyle]) {
    style = STYLE_PRESETS[effectiveStyle];
  } else if (typeof effectiveStyle === "string" && effectiveStyle.trim().length >= 2) {
    style = effectiveStyle.trim();
  } else {
    style = STYLE_PRESETS.match;
  }
  withText = effectiveWithText; // override the local var the rest of the fn uses

  // Language hint for rendered text. Auto = trust whatever script the
  // phrase string is in (Gemini handles mixed scripts well).
  const LANG_LABEL = {
    "zh-TW": "Traditional Chinese (繁體中文) glyphs",
    "zh-CN": "Simplified Chinese (简体中文) glyphs",
    en: "Latin alphabet English",
    ja: "Japanese kana + kanji glyphs",
    ko: "Korean Hangul glyphs",
  };
  const langScriptHint = LANG_LABEL[lang] || null;

  const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
  const NAMES = [
    "top-left", "top-centre", "top-right",
    "middle-left", "middle-centre", "middle-right",
    "bottom-left", "bottom-centre", "bottom-right",
  ];
  const layout = LETTERS.map((letter, i) => {
    const slot = nine[i];
    const phrase = slot.phrase;
    const action = actionFor(slot);
    if (withText) {
      return `  [${letter}] ${NAMES[i]} cell:
      EXACT TEXT TO PRINT (verbatim, character-by-character, no substitution): "${phrase}"
      TEXT STYLE: Impact-meme style — PURE WHITE fill with a thick (5-8px) PURE BLACK outline hugging every glyph. Bold rounded sans-serif font. Readable on any chat background. Place text at the top OR bottom edge of the cell, edge-to-edge. The black outline matches the character's black outline for visual unity.
      ACTION/POSE: ${action}`;
    }
    // withText=false: phrase is NOT rendered, but still drives the pose.
    // Without this, Gemini got no semantic guidance and drew random poses.
    return `  [${letter}] ${NAMES[i]} cell:
      EMOTION CUE (do NOT render as text on the sticker — use ONLY as pose / facial-expression guidance): "${phrase}"
      ACTION/POSE: render a pose + facial expression that clearly conveys the feeling of "${phrase}". ${action}
      ABSOLUTELY NO TEXT, LETTERS, NUMBERS, OR EMOJI on this cell.`;
  }).join("\n");

  const diagram = `\`\`\`
+------+------+------+
|  A   |  B   |  C   |
+------+------+------+
|  D   |  E   |  F   |
+------+------+------+
|  G   |  H   |  I   |
+------+------+------+
\`\`\``;

  return `Create a single 3×3 grid image: 3 rows × 3 columns of 9 equal-size square LINE-style stickers featuring the same character from the reference image. Each tile is ONE complete chat sticker.

STYLE (DOMINANT — overrides the source image's medium):
${style}

This style applies to ALL 9 tiles. If the user provided a photo and the style says "anime / 3D / pixel / watercolor / etc", TRANSFORM the photo into that medium — do NOT keep it photo-realistic. If the style says "match" then keep the source medium; otherwise the style above wins. Color palette, line work, shading technique should all follow the STYLE block, not the source.

CHARACTER IDENTITY (persists across all 9 tiles, but is RE-RENDERED in the chosen style):
The character must be recognizably the same person/creature across all 9 tiles — same hair colour & shape, same clothing colour, same general face features. But identity does NOT mean keeping the source medium. If the source is a photo and the style is anime, the 9 tiles are 9 anime portraits of "this person turned anime". If the style is pixel art, the 9 tiles are 9 pixel-art versions of the same character. Only the pose / expression / phrase changes between tiles; the rendered art style stays uniform.

STICKER FRAMING (every tile):
- Subject is the upper body or full body of the character, fully inside the cell with comfortable margin.
- Background is plain solid PURE NEON GREEN (#00FF00) — this is a chroma-key plate that will be programmatically removed by the downstream tool. Use exactly #00FF00 only for the background plate. NO gradients, NO shading, NO scenery, NO patterns, NO ground plane, NO platform, NO cast shadow, NO contact shadow. Same identical #00FF00 green across all 9 cells.
- CRITICAL: the character itself must contain NO GREEN elements anywhere. NO green clothes, NO green hair, NO green eyes, NO green accessories, NO green objects. If the original reference has any green, substitute it with red, orange, blue, purple, or yellow. Even slight greenish tints on white clothes or skin should be avoided. This is essential — green pixels on the character will be chroma-keyed out and become holes.
- Do not use #00FF00, neon green, chroma green, or green-tinted colors for the character, outlines, highlights, shadows, reflected light, props, floor, ground, platforms, leaves, grass, objects, or any area inside the character silhouette. Only the removable background plate may be green.
- CHARACTER OUTLINE: trace the entire character silhouette with a clean, uniform 2-3px PURE BLACK outline (the boundary between character and the green background). Apply consistently and identically across ALL 9 cells. This gives the sticker pack a unified "die-cut sticker" look and lets downstream bg removal find the silhouette precisely. Even photo-realistic stickers should have this clean black outline added.
- ABSOLUTELY NO real brand logos, monograms, or trademarked markings on ANY object — no Chanel CC interlocking pattern, no Louis Vuitton LV monogram, no Gucci GG, no Hermes H, no Burberry check, no Prada triangle, no Nike swoosh, no Apple logo, no Starbucks siren, no automotive logos, etc. ALSO NO fake brand-style English/letter text printed on bags / wallets / clothing / accessories (no "GUVICY" / "PRADO" / "CHANEEL" type fabricated brand-like text either — model often hallucinates fake brand text on luxury items, do NOT do that). All bags, wallets, phones, hats, watches, clothing must be either completely plain (solid color only) or have only abstract non-trademark decoration (a single ribbon, a generic flower, a heart, a star, plain stitching). This rule is STRICT — LINE Creators Market auto-rejects any sticker containing real or fake brand markings, costing the user days of resubmission time.
- ALSO AVOID iconic luxury BAG SILHOUETTES even when no logo is drawn. Many luxury bags are protected by design patents (新式樣專利) covering the silhouette itself, separate from the logo. Specifically AVOID drawing handbags shaped like: Hermes Birkin or Kelly (trapezoid body with a CENTRAL TURN-LOCK metal closure and two short top handles + two leather straps coming down from the top to fasten the lock — do NOT draw this configuration), Chanel Classic Flap or Boy bag (diamond-quilted leather with a chain-and-leather strap), Louis Vuitton Speedy (rounded barrel zip-top with two short rolled handles), Louis Vuitton Neverfull (open tote with vachetta leather trim and side cinch laces), Dior Lady (cannage quilted body with metal charm letters dangling from handle), Prada Galleria (saffiano leather with triangular plate), Gucci Bamboo (top handle made of bamboo segments), Goyard Saint Louis (chevron herringbone canvas), Fendi Baguette (small rectangular underarm bag). When the scene calls for a handbag, instead draw GENERIC bag shapes: a soft slouchy shoulder bag, a plain canvas tote with simple curved handles, a basic round crossbody, a plain drawstring bucket bag, or a paper shopping bag with cute illustration. Use plain leather/fabric textures with NO quilting patterns, NO distinctive turn-lock metal hardware, NO signature stitching cuts, NO chain straps. The bag should read as "a bag" not as "an obvious luxury brand bag minus the logo".
- No drop shadows, no soft shadows under feet, no contact shadows, no ground shadows, no ambient green glow.
- Bold, lively poses — readable at chat-thumbnail size (~120×120 px).

CONTENT COMPLIANCE — LINE Creators Market审核 rules. EVERY cell must comply. ANY violation gets the entire pack auto-rejected, costing the operator days of resubmission. Treat every rule below as hard constraints that override style / theme / user preference:

[A] PORTRAIT RIGHTS — no real public figures
- Do NOT render the character to look recognizably like any real celebrity, KOL, athlete, politician, royalty, religious leader, or other identifiable public figure. If the user's reference image resembles a famous person, deliberately stylize away from that resemblance: change face shape, hair, eye color, age — keep ONLY the user's intent of "a person" and produce a clearly original cartoon character. Better to lose photo-realistic likeness than to accidentally depict, say, a Korean idol or a politician.

[B] COPYRIGHTED IP — no trademarked characters
- Do NOT redraw, imitate, parody, or reference any copyrighted/trademarked cartoon, anime, game, comic, or movie character. Hard ban list (non-exhaustive): Pokemon (Pikachu / Eevee / etc.), Sanrio (Hello Kitty / My Melody / Cinnamoroll / Kuromi / Pompompurin), Disney / Pixar (Mickey / Mickey ears / Princesses / Frozen / Toy Story / Marvel / Star Wars), Studio Ghibli (Totoro / No-Face / Kiki), Nintendo (Mario / Luigi / Zelda / Pikmin / Animal Crossing), DC Comics, Crayon Shin-chan, Doraemon, Anpanman, One Piece, Naruto, Demon Slayer (Kimetsu no Yaiba), Jujutsu Kaisen, Spy x Family, Sumikko Gurashi, Line Friends (Brown / Cony / Sally — yes EVEN LINE'S OWN MASCOTS are off-limits for third-party stickers), Miffy, Peanuts (Snoopy / Charlie Brown), Garfield, Pucca, Rilakkuma. The character must be 100% original even if user's reference resembles one of the above.

[C] BRAND TRADEMARKS — covered above in STICKER FRAMING. (NO real brand logos, NO fabricated brand-style text on accessories.)

[D] SEXUAL / NUDITY
- Character must be fully clothed in modest everyday wear. NO exposed genitals, NO exposed nipples (any gender), NO bare buttocks, NO sheer/see-through clothing, NO underwear-only shots, NO swimsuits more revealing than a one-piece / boardshorts, NO fetish gear, NO bondage imagery, NO sexually suggestive poses (e.g. spread legs, sexualized licking, breasts thrust forward as the focal point). Cute / pretty / glamorous is fine; sexualized is not.

[E] VIOLENCE / GORE
- NO blood (cartoon nosebleed for "embarrassed" emotion is borderline OK only if minimal, but avoid). NO severed limbs. NO realistic weapons used aggressively against another character (a chef holding a knife to cook is fine; a knife pointed at someone is not). NO firearms aimed at characters. NO depictions of self-harm, suicide, or graphic injury. Cartoon impact effects (stars, BAM, sweatdrops) are fine.

[F] HATE / DISCRIMINATION
- NO caricatures that mock or stereotype people by race, ethnicity, nationality, religion, gender identity, sexual orientation, disability, or body type. NO derogatory symbols (swastikas, KKK imagery, etc.). Skin tones and features must be drawn respectfully if the reference is from any specific ethnic group.

[G] RELIGION
- NO Buddha statues, NO crucifixes, NO Star of David, NO Quranic calligraphy, NO Hindu deities, NO Shinto torii as a religious object, NO mantra/sutra text, NO clergy attire (priest robes, monk robes, hijab as religious uniform), NO religious gestures with religious context. Generic spiritual / "lucky" symbols (a four-leaf clover, a horseshoe) are OK.

[H] POLITICS
- NO political party logos, NO campaign slogans, NO portraits of politicians (current or historical), NO national flags as the central visual focus, NO protest/activist signage, NO political rally imagery, NO military uniforms as costume.

[I] DRUGS / ALCOHOL / TOBACCO / GAMBLING
- NO syringes, pills, drug paraphernalia, marijuana leaves, smoking depictions, bong / pipe imagery. NO casino imagery (slot machines, poker chips, dice in gambling context, roulette wheel). A normal coffee mug, tea cup, single wine glass at dinner, plain beer mug at a party — all OK if not the focus and not promoting excess.

[J] DEFAMATION / HARASSMENT / PERSONAL INFO
- NO real personal names (other than the assigned phrase if it happens to contain a name), NO phone numbers, NO email addresses, NO physical addresses, NO QR codes, NO external URLs printed on the sticker. NO content directed at a real specific identifiable third party.

[K] MEDICAL / FINANCIAL CLAIMS
- NO before/after weight loss imagery, NO "cures X disease" type claims, NO medical advice imagery, NO get-rich-quick / pyramid scheme imagery, NO crypto pump signage.

[L] OTHER LINE-SPECIFIC
- NO content depicting child endangerment, child sexualization, or any content involving minors that would be inappropriate.
- NO depictions of cruelty to animals.
- NO QR codes or barcodes (LINE auto-rejects).

If a user-supplied phrase or theme would push you toward violating any of the above (e.g. user types a phrase referencing a real celebrity, or asks for "Pokemon trainer" style), reinterpret the request to comply: render the character generically without the brand/IP/person reference. Compliance > style > theme > user wording.

LAYOUT — each cell shows EXACTLY the action mapped to its letter; do not swap, merge, or skip cells:

${diagram}

${layout}

OUTPUT RULES — strictly enforced:
- Final image is a 3×3 sticker grid. ONE seamless 1:1 image.
- No visible borders, gutters, dividers, or letter labels (A..I) drawn on the image. The layout above is for you, not text to paint.
- ${withText
    ? `Each cell may contain ONLY the assigned phrase as overlaid text — render it in whatever script/language it was written in (Chinese / English / Japanese / Korean / emoji / mixed all OK). Do NOT add extra words, do NOT translate, do NOT add decorative letters/numbers beyond what is in the assigned phrase.${
        langScriptHint
          ? ` The user has indicated the intended sticker text language is ${langScriptHint} — render any glyphs cleanly and correctly in that script.`
          : ""
      }`
    : 'No text, letters, numbers, captions, or watermarks anywhere on the image.'}
- Every cell must use a PURE WHITE background — uniform across all 9 cells, no off-white, no cream, no gray.
- The character must be obviously the same person/creature/style as the reference in all 9 cells.
- Two cells MUST NOT share the same pose — vary arms, head tilt, expression.
- ${withText
    ? 'TEXT FIDELITY (most important rule): the 9 phrases above are FIXED — render each phrase EXACTLY as assigned to its letter, character by character. Do NOT swap a phrase between cells. Do NOT substitute with synonyms. Do NOT translate or paraphrase. Do NOT pick alternative phrases from the same theme. The text on cell A must be the exact string after "EXACT TEXT TO PRINT" for cell A — no exceptions.'
    : 'NO TEXT anywhere — zero characters / letters / numbers / emoji on any tile. BUT each cell\'s pose and facial expression MUST clearly convey the EMOTION CUE phrase assigned to that letter. Cell A\'s pose expresses cell A\'s phrase, cell B\'s pose expresses cell B\'s phrase, etc. — do NOT shuffle which emotion goes to which cell. The phrase guides the drawing even though it is never rendered.'}${
    camp && camp.extraPromptInstruction
      ? `\n\n${camp.extraPromptInstruction}`
      : ""
  }`;
}

// ---------- Client IP + Cloudflare Turnstile ----------
//
// We rate-limit by IP (CF-Connecting-IP, set by Cloudflare on every
// request — spoof-proof from the outside). Turnstile is a separate
// gate: every AI-spending request carries a Turnstile token that we
// hand to Cloudflare's siteverify endpoint to confirm it came from a
// real browser, not a script.

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function verifyTurnstile(env, token, ip) {
  if (!env || !env.TURNSTILE_SECRET) {
    return { ok: false, reason: "TURNSTILE_SECRET not configured on worker" };
  }
  if (!token || typeof token !== "string") {
    return { ok: false, reason: "missing turnstile token" };
  }
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const r = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form },
    );
    const data = await r.json();
    if (data && data.success) return { ok: true };
    return {
      ok: false,
      reason: (data && data["error-codes"] && data["error-codes"].join(",")) || "verify failed",
    };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

// ---------- Daily quota tracking via Cloudflare KV ----------
//
// Keyed `quota:<ip>:<YYYY-MM-DD UTC>`. TTL is 36 hours so old keys
// self-clean a day after the count became irrelevant. If the QUOTA KV
// binding is missing (e.g. local dev without KV), quota is reported as
// unlimited so the app still functions.

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function quotaKey(ip) {
  return `quota:${ip}:${todayUTC()}`;
}

async function readQuota(env, ip) {
  if (!env || !env.QUOTA) return { used: 0, limit: DAILY_LIMIT, kvAvailable: false };
  const used = parseInt((await env.QUOTA.get(quotaKey(ip))) || "0", 10);
  return { used, limit: DAILY_LIMIT, kvAvailable: true };
}

async function bumpQuota(env, ip) {
  if (!env || !env.QUOTA) return DAILY_LIMIT; // pretend unlimited if no KV
  const k = quotaKey(ip);
  const used = parseInt((await env.QUOTA.get(k)) || "0", 10);
  const next = used + 1;
  await env.QUOTA.put(k, String(next), { expirationTtl: 60 * 60 * 36 });
  return next;
}

// Refund a quota slot when the upstream call failed AFTER we'd already
// pre-emptively bumped. Keeps us "honest" — only successful generations
// burn the user's daily allowance.
async function decrementQuota(env, ip) {
  if (!env || !env.QUOTA) return;
  const k = quotaKey(ip);
  const used = parseInt((await env.QUOTA.get(k)) || "0", 10);
  if (used <= 0) return;
  await env.QUOTA.put(k, String(used - 1), { expirationTtl: 60 * 60 * 36 });
}

// ---------- Per-IP in-flight serialization ----------
//
// Without this, a malicious user spam-clicking "Generate" fires N
// concurrent requests; each one passes the quota check before any of
// them increments (KV is last-write-wins, not atomic). All N call
// Vertex → all N cost real money → only 1 of N gets credited.
//
// Mitigation: at request entry, set `inflight:<ip>` in KV. While that
// key exists, reject incoming requests for that same IP with 429.
// Always delete it in `finally`. TTL 180s is a safety net in case the
// worker dies mid-request and never reaches `releaseInflight`.

const INFLIGHT_TTL_SECONDS = 180;

function inflightKey(ip) {
  return `inflight:${ip}`;
}

// Returns true if we acquired the lock, false if another request from
// the same IP is already in flight. KV is eventually consistent so two
// near-simultaneous calls may both see "no lock"; we accept that small
// race in exchange for not paying for Durable Objects. The window is
// milliseconds — much narrower than a 50-second Vertex call.
async function acquireInflight(env, ip) {
  if (!env || !env.QUOTA) return true;
  const k = inflightKey(ip);
  if (await env.QUOTA.get(k)) return false;
  await env.QUOTA.put(k, "1", { expirationTtl: INFLIGHT_TTL_SECONDS });
  return true;
}

async function releaseInflight(env, ip) {
  if (!env || !env.QUOTA) return;
  await env.QUOTA.delete(inflightKey(ip));
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";
    const cors = corsHeaders(origin);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (request.method === "GET") {
      if (url.pathname === "/phrases") {
        return json({ phrases: phrasesManifest() }, 200, cors);
      }
      if (url.pathname === "/styles") {
        return json({ styles: Object.keys(STYLE_PRESETS) }, 200, cors);
      }
      if (url.pathname === "/campaigns") {
        return json({ campaigns: campaignsManifest() }, 200, cors);
      }
      if (url.pathname === "/quota") {
        // Public — returns this caller's IP-keyed daily quota. No auth.
        const ip = getClientIp(request);
        const quota = await readQuota(env, ip);
        return json({ quota }, 200, cors);
      }
      if (url.pathname === "/config") {
        // Public — frontend reads the Turnstile site key + daily limit
        // here so they're not hardcoded in two places.
        return json({
          turnstileSiteKey: TURNSTILE_SITE_KEY,
          dailyLimit: DAILY_LIMIT,
        }, 200, cors);
      }
      return json({ ok: true, service: "line-sticker-gemini" }, 200, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405, cors);
    }

    // POST /generate-themes — Gemini text model brainstorms 8 themed
    // sticker phrases from a user description. Used by the slot dialog
    // "✨ 用 AI 產 8 句" button to fill custom phrases at once.
    if (url.pathname === "/generate-themes") {
      if (!env.VERTEX_API_KEY) {
        return json({ error: "VERTEX_API_KEY missing" }, 500, cors);
      }
      let body;
      try { body = await request.json(); } catch { body = {}; }
      // Turnstile gate — same secret as /generate, prevents scripts from
      // looping the brainstorm endpoint to burn API budget.
      const tsResult = await verifyTurnstile(
        env, body?.turnstileToken, getClientIp(request),
      );
      if (!tsResult.ok) {
        return json(
          { error: "turnstile verification failed", detail: tsResult.reason },
          403, cors,
        );
      }
      const description = String(body?.description || "").trim();
      if (!description) {
        return json({ error: "description required" }, 400, cors);
      }
      const lang = String(body?.lang || "zh-TW");
      const prompt = `你是 LINE 貼圖文案 + 動作發想助手。根據使用者描述的主題，產出 8 組「短語 + 對應動作描述」配對。

每組包含：
- "phrase": 2-8 字短語 (語氣口語、聊天感、情緒鮮明、避免廣告或商標)。語言：${lang === "en" ? "English" : lang === "ja" ? "日本語" : lang === "ko" ? "한국어" : "繁體中文"}
- "action": 5-15 字英文動作 + 表情描述 (用英文，因為 Gemini image 對英文 pose description 理解最準)。例：「slumped at desk, weary look, head in hands」「jumping in the air arms wide, huge smile」

使用者主題：「${description}」

請只回 JSON 陣列、無 markdown 包裝：
[
  {"phrase":"短語1","action":"english action description"},
  {"phrase":"短語2","action":"english action description"},
  ... × 8
]`;
      const apiUrl = `https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent?key=${env.VERTEX_API_KEY}`;
      const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      };
      try {
        const upstream = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!upstream.ok) {
          const detail = await upstream.text();
          return json({ error: "upstream", detail: detail.slice(0, 800) }, 502, cors);
        }
        const data = await upstream.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
        let parsed;
        try { parsed = JSON.parse(text); } catch {
          // Try to extract array from text
          const m = text.match(/\[[\s\S]*\]/);
          parsed = m ? JSON.parse(m[0]) : [];
        }
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return json({ error: "no phrases", raw: text.slice(0, 500) }, 502, cors);
        }
        // Normalise to [{ phrase, action? }] — accept either old string-only
        // shape or the new {phrase, action} object shape.
        const items = parsed.slice(0, 8).map((entry) => {
          if (typeof entry === "string") return { phrase: entry.trim() };
          if (entry && typeof entry === "object") {
            const phrase = String(entry.phrase || "").trim();
            const action = String(entry.action || "").trim();
            return action ? { phrase, action } : { phrase };
          }
          return { phrase: String(entry || "").trim() };
        }).filter((s) => s.phrase);
        return json(
          {
            // Back-compat field — string array of phrases only.
            phrases: items.map((s) => s.phrase),
            // New field — full {phrase, action} pairs.
            slots: items,
          },
          200, cors,
        );
      } catch (err) {
        return json({ error: "fetch failed", detail: String(err) }, 502, cors);
      }
    }

    // POST /admin/reset-quota — nuke a specific IP's daily quota.
    // Authorized via `Authorization: Bearer <ADMIN_TOKEN>` matching the
    // ADMIN_TOKEN secret. Body is `{ ip?: string }`; if omitted, resets
    // the caller's own IP. Set the secret with:
    //   npx wrangler secret put ADMIN_TOKEN
    if (url.pathname === "/admin/reset-quota") {
      const auth = request.headers.get("Authorization") || "";
      const m = auth.match(/^Bearer\s+(.+)$/i);
      const provided = m ? m[1].trim() : "";
      if (!env.ADMIN_TOKEN || !provided || provided !== env.ADMIN_TOKEN) {
        return json({ error: "forbidden" }, 403, cors);
      }
      let body = {};
      try { body = await request.json(); } catch {}
      const ip = (body && typeof body.ip === "string" && body.ip.trim())
        || getClientIp(request);
      if (env.QUOTA) {
        await env.QUOTA.delete(quotaKey(ip));
      }
      return json(
        { ok: true, message: "Quota reset to 0", ip },
        200, cors,
      );
    }

    // POST /prompt — returns the assembled prompt without calling Gemini.
    // Useful for letting the user copy the prompt into gemini.google.com
    // themselves to save the operator's API budget.
    if (url.pathname === "/prompt") {
      let body;
      try { body = await request.json(); } catch { body = {}; }
      const nine = pickNineSlots({
        slots: body?.slots,
        phrases: body?.phrases,
        campaign: body?.campaign,
      });
      const promptText = buildPrompt({
        nine,
        styleHint: body?.styleHint,
        withText: body?.withText !== false,
        campaign: body?.campaign,
        lang: body?.lang,
      });
      return json(
        {
          prompt: promptText,
          phrases: nine.map((s) => s.phrase),
          slots: nine,
        },
        200, cors,
      );
    }

    if (!env.VERTEX_API_KEY) {
      return json(
        { error: "server misconfigured: VERTEX_API_KEY missing" },
        500,
        cors,
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400, cors);
    }

    const ip = getClientIp(request);

    // ---- Cheap gates first (Turnstile + body shape) ----
    // We do these BEFORE acquiring the in-flight lock so a malformed
    // request from one tab doesn't lock out the user's other tab for
    // the next 3 minutes.
    const tsResult = await verifyTurnstile(env, body?.turnstileToken, ip);
    if (!tsResult.ok) {
      return json(
        {
          error: "turnstile verification failed",
          hint: "byog",
          detail: tsResult.reason,
          message: "人機驗證失敗或過期，請重新整理頁面再試。或走 BYOG 路徑（免費、不需驗證）。",
        },
        403,
        cors,
      );
    }

    const {
      imageBase64,
      mimeType = "image/jpeg",
      prompt,
      model,
      phrases,
      slots,
      styleHint,
      withText,
      campaign,
      lang,
    } = body || {};

    if (typeof imageBase64 !== "string" || imageBase64.length < 100) {
      return json({ error: "imageBase64 is required" }, 400, cors);
    }
    if (imageBase64.length * 0.75 > MAX_INPUT_BYTES) {
      return json({ error: "image too large (max ~7.5 MB)" }, 413, cors);
    }

    // ---- Acquire per-IP in-flight lock ----
    const gotLock = await acquireInflight(env, ip);
    if (!gotLock) {
      const quotaNow = await readQuota(env, ip);
      return json(
        {
          error: "in flight",
          quota: quotaNow,
          message: "上一個生成還在跑（最久 50 秒）。等它完成或失敗再點，狂點不會更快、還會被擋。",
        },
        429,
        cors,
      );
    }

    // Everything from here on must release the lock — wrap in try/finally.
    try {
      // ---- Daily quota gate ----
      const quotaBefore = await readQuota(env, ip);
      if (quotaBefore.used >= quotaBefore.limit) {
        return json(
          {
            error: "daily quota exceeded",
            hint: "byog",
            quota: quotaBefore,
            message: `今天的 ${quotaBefore.limit} 次 AI 生成已用完。可以複製 prompt 自己到 Gemini 跑、再丟回來走 BYOG 路徑（免費、不限次）。明天 UTC 0 點重置。`,
          },
          429,
          cors,
        );
      }

      // ---- Pre-emptive bump (charge BEFORE the upstream call) ----
      // This is the key defense against spam-clicking: a flood of
      // simultaneous requests each bumps before any of them returns,
      // so the 6th-Nth request hits the quota gate above without ever
      // calling Vertex. Refunded below on known-recoverable errors.
      const usedAfter = await bumpQuota(env, ip);

      const chosenModel = (model || env.DEFAULT_MODEL || DEFAULT_MODEL).trim();
      // Pick the 9 phrases ONCE per request, then use the same set both
      // for the prompt sent to Gemini AND the response. (Earlier bug:
      // pickNineSlots was called twice → two different random sets, so
      // the response's `phrases` never matched what Gemini saw.)
      const nine = pickNineSlots({ slots, phrases, campaign });
      const chosenPrompt = typeof prompt === "string" && prompt.trim()
        ? prompt
        : buildPrompt({
            nine,
            styleHint,
            withText: withText !== false,
            campaign,
            lang,
          });

      const apiUrl = `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(chosenModel)}:generateContent?key=${env.VERTEX_API_KEY}`;

      const payload = {
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType, data: imageBase64 } },
              { text: chosenPrompt },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: "1:1", imageSize: "2K" },
        },
      };

      let upstream;
      try {
        upstream = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        // Network-level failure → didn't hit Vertex. Refund.
        await decrementQuota(env, ip);
        return json(
          { error: "upstream fetch failed", detail: String(err) },
          502,
          cors,
        );
      }

      if (!upstream.ok) {
        const text = await upstream.text();
        // Vertex returned a 4xx/5xx — we may still be billed if it was
        // 4xx (bad request format), but mostly these are 502/503/524 on
        // their side. Refund either way; if a 4xx pattern develops we'd
        // see it in logs and tighten our prompt-builder.
        await decrementQuota(env, ip);
        return json(
          {
            error: "upstream error",
            status: upstream.status,
            detail: text.slice(0, 1500),
          },
          502,
          cors,
        );
      }

      const data = await upstream.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p) => p.inlineData);
      if (!imagePart) {
        // Vertex 200'd but didn't return an image (safety filter / model
        // quirk). We DID get billed for this. Don't refund — the user's
        // input triggered a real billable call.
        return json(
          {
            error: "no image in response",
            raw: JSON.stringify(data).slice(0, 1500),
            quota: { used: usedAfter, limit: DAILY_LIMIT },
          },
          502,
          cors,
        );
      }

      return json(
        {
          mimeType: imagePart.inlineData.mimeType || "image/png",
          data: imagePart.inlineData.data,
          model: chosenModel,
          phrases: nine.map((s) => s.phrase),
          slots: nine,
          campaign: campaign || null,
          lang: lang || null,
          quota: { used: usedAfter, limit: DAILY_LIMIT },
        },
        200,
        cors,
      );
    } finally {
      // Always release the in-flight lock — success, error, or thrown.
      await releaseInflight(env, ip);
    }
  },
};
