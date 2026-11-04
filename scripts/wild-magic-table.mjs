/**
 * THE WILD MAGIC SURGE TABLE, as data. Imports nothing: wild-magic.mjs reads it and is
 * the only place that knows what any of these fields DO.
 *
 * Every entry has `text`, the line printed on the chat card. `{name}` placeholders in
 * it are filled from `rolls` (rolled when the surge happens, so the card states the
 * result instead of leaving a formula to roll by hand) and from `pick` (a coin flip,
 * a random colour). Everything else is optional automation:
 *
 *   effect   an ActiveEffect. `on`: caster | target | both | coin (41: whoever the coin
 *            picked) | area (everyone within `radius` ft of `center`, caster or target)
 *            | randomAlly (71: the caster and one random ally) | randomNear (73).
 *            `rounds`/`seconds` is the duration (none = until removed by hand).
 *            `changes`/`statuses` are the mechanics; most entries have none and the
 *            effect is a reminder on the token with the text as its description.
 *   spell    cast that spell from a compendium, at `level`, without a slot.
 *   damage   a damage roll card (dnd5e's own apply buttons), with an optional save.
 *   save     the caster rolls this saving throw.
 *   heal     the caster regains hit points; `tempHp` gives the target temporary ones.
 *   mana     the caster's mana changes by the rolled amount (or their Sorcerer level).
 *   coins    silver pieces gained; `cycleCurrency` rotates cp -> sp -> gp -> cp.
 *   grant    one more action this turn, booked on the HUD's economy.
 *   recurring  repeats at the start of each of the caster's turns while the effect lasts.
 *
 * 1 minute = 10 rounds = 60 seconds. "Until the start of their next turn" is 1 round.
 */

const MIN = { rounds: 10, seconds: 60 };
const ROUND = { rounds: 1, seconds: 6 };
const HOUR = { seconds: 3600 };
const DAY = { seconds: 86400 };

export const SURGE_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "black", "white", "pink", "brown"];

export const WILD_MAGIC_TABLE = {
  1: {
    text: "Roll on this table at the start of each of the caster's turns for 1 minute.",
    effect: { on: "caster", name: "Chaotic Surges", ...MIN, recurring: "surge" }
  },
  2: { text: "Caster and target switch positions after the spell ends." },
  3: {
    text: "Caster can see invisible creatures until the next sunset.",
    effect: { on: "caster", name: "See Invisibility (until sunset)", ...DAY }
  },
  4: {
    text: "A normal riding horse appears within 10 feet of the caster. At the start of the caster's next turn, it erupts in flames, and its ashes scatter away in the wind (even if this happens inside an enclosed area like a dungeon)."
  },
  5: {
    text: "A modron appears within 5 feet of the caster and begins scribbling down details of the room onto a piece of parchment for 1 minute before disappearing. During this time, it ignores anyone's attempts to communicate with it. If it takes any damage, it immediately plane shifts back to Mechanus (cannot be counterspelled)."
  },
  6: { text: "Caster vomits out Plant Growth centered on themselves.", spell: { name: "Plant Growth" } },
  7: { text: "Fireball is cast at 3rd level centered on the caster.", spell: { name: "Fireball", level: 3 } },
  8: { text: "All nonmagical weapons in a 60-foot radius of the caster turn into food for 1 minute." },
  9: {
    text: "The spell is not cast right away. Instead, it is cast at the start of the caster's next turn, dealing double damage or lasting twice as long if it deals no damage.",
    effect: { on: "caster", name: "Delayed Spell (double effect)", ...ROUND }
  },
  10: {
    text: "Next time the caster speaks, they breathe out a 30-foot-long, 5-foot-wide line of fire (5d6 fire damage, Dexterity save for half).",
    effect: { on: "caster", name: "Fire Breath (next time you speak)" },
    damage: { formula: "5d6", type: "fire", save: "dex" }
  },
  11: {
    text: "Caster's height changes by {inches} inches: they {grow}.",
    rolls: { inches: "1d10" },
    derive: (v) => ({ grow: v.inches % 2 === 0 ? "grow" : "shrink" })
  },
  12: {
    text: "Target is cocooned in crystal until someone breaks it: AC 18, {temp} temporary HP, prone, restrained and incapacitated, but still aware of its surroundings.",
    rolls: { temp: "5d10+20" },
    effect: {
      on: "target", name: "Crystal Cocoon",
      statuses: ["prone", "restrained", "incapacitated"],
      changes: [
        { key: "system.attributes.ac.calc", mode: 5, value: "flat" },
        { key: "system.attributes.ac.flat", mode: 5, value: "18" }
      ]
    },
    tempHp: "temp"
  },
  13: { text: "Confusion is cast centered on the caster.", spell: { name: "Confusion" } },
  14: { text: "All magical weapons within 20 feet of the caster lose their magical properties until the start of the caster's next turn." },
  15: {
    text: "Caster regains 5 HP at the start of each of their turns for 1 minute.",
    effect: { on: "caster", name: "Surging Vitality", ...MIN, recurring: "heal5" }
  },
  16: {
    text: "Target is transported to the Ethereal Plane for 1 minute.",
    effect: { on: "target", name: "Ethereal Plane", ...MIN }
  },
  17: {
    text: "Caster grows a long beard made of feathers. It remains on their face until they sneeze.",
    effect: { on: "caster", name: "Feather Beard" }
  },
  18: { text: "A swarm of rats carries the caster 30 feet in a random direction ({direction})." , pick: { direction: ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"] } },
  19: { text: "Grease is cast centered on the caster.", spell: { name: "Grease" } },
  20: {
    text: "Creatures within 30 feet of the target are stuck in place and restrained. At the start of each of their turns they can attempt a DC 15 Strength saving throw to break free.",
    effect: { on: "area", center: "target", radius: 30, includeCenter: false, name: "Stuck in Place (DC 15 STR)", statuses: ["restrained"] }
  },
  21: {
    text: "The worn clothes and armor of both the target and the caster become solid adamantine until the end of their next turn. Their AC becomes 24 regardless of what they are wearing, but they are restrained.",
    effect: {
      on: "both", name: "Adamantine Clothes", rounds: 1, turns: 1, seconds: 12,
      statuses: ["restrained"],
      changes: [
        { key: "system.attributes.ac.calc", mode: 5, value: "flat" },
        { key: "system.attributes.ac.flat", mode: 5, value: "24" }
      ]
    }
  },
  22: { text: "A mature oak tree sprouts in an unoccupied space within 60 feet of the caster." },
  23: {
    text: "The skin of the caster's feet turns vibrant blue. This lasts until Remove Curse or a similar spell is cast on them.",
    effect: { on: "caster", name: "Blue Feet" }
  },
  24: {
    text: "Caster can only speak to animals for 8 hours.",
    effect: { on: "caster", name: "Animal Speech Only", seconds: 28800 }
  },
  25: {
    text: "Caster grows a third eye on their forehead; they have advantage on Wisdom (Perception) checks that rely on sight for 1 minute.",
    effect: { on: "caster", name: "Third Eye", ...MIN, changes: [{ key: "system.skills.prc.roll.mode", mode: 2, value: "1" }] }
  },
  26: {
    text: "Caster gains 100 lbs and their base walking speed is halved for 1 minute.",
    effect: { on: "caster", name: "+100 lbs", ...MIN, changes: [{ key: "system.attributes.movement.walk", mode: 1, value: "0.5" }] }
  },
  27: {
    text: "The next spell the caster casts uses both their action and their bonus action.",
    effect: { on: "caster", name: "Heavy Casting (action + bonus action)" }
  },
  28: {
    text: "On their next turn, the caster takes no action as they vomit out {silver} silver pieces.",
    rolls: { silver: "1d100+10" },
    effect: { on: "caster", name: "Vomiting Silver", rounds: 2, seconds: 12 },
    coins: { sp: "silver" }
  },
  29: { text: "Caster teleports up to 60 feet to an unoccupied space of their choice." },
  30: {
    text: "Caster's hands and feet become covered in sticky goop for 10 minutes or until washed off.",
    effect: { on: "caster", name: "Sticky Goop", rounds: 100, seconds: 600 }
  },
  31: {
    text: "Caster is transported to the Astral Plane until the start of their next turn.",
    effect: { on: "caster", name: "Astral Plane", ...ROUND }
  },
  32: { text: "Cabbages sprout abundantly within a 30-foot radius centered on the caster." },
  33: {
    text: "The next spell the caster casts within 1 minute that deals damage deals maximum damage.",
    effect: { on: "caster", name: "Maximized Spell", ...MIN }
  },
  34: {
    text: "Caster can mimic the target's voice perfectly for 24 hours.",
    effect: { on: "caster", name: "Voice Mimicry", ...DAY }
  },
  35: {
    text: "Caster's age changes by {years} years: they become {older}.",
    rolls: { years: "1d10" },
    derive: (v) => ({ older: v.years % 2 === 0 ? "older" : "younger" })
  },
  36: {
    text: "Caster grows antlers, and sheds them in 24 hours.",
    effect: { on: "caster", name: "Antlers", ...DAY }
  },
  37: {
    text: "{flumphs} scared flumphs appear within 60 feet for 1 minute. They spend their turns telepathically screaming and/or fleeing.",
    rolls: { flumphs: "2d4" }
  },
  38: { text: "Caster and target are flung 10 feet in opposite directions." },
  39: { text: "Caster regains {hp} hit points.", rolls: { hp: "5d4+5" }, heal: "hp" },
  40: { text: "Gravity reverses in a 30-foot radius centered on the caster until the start of their next turn." },
  41: {
    text: "Coin flip: {coin}. The {who} becomes a potted plant until the start of their next turn.",
    pick: { coin: ["heads", "tails"] },
    derive: (v) => ({ who: v.coin === "heads" ? "caster" : "target" }),
    effect: { on: "coin", name: "Potted Plant", ...ROUND, statuses: ["incapacitated"] }
  },
  42: {
    text: "Caster is distracted by a cloud of gnats for the next minute: disadvantage on Perception checks and attack rolls.",
    effect: {
      on: "caster", name: "Cloud of Gnats", ...MIN,
      changes: [
        { key: "system.skills.prc.roll.mode", mode: 2, value: "-1" },
        { key: "flags.midi-qol.disadvantage.attack.all", mode: 5, value: "1" }
      ]
    }
  },
  43: {
    text: "For the next minute, the caster can teleport to any point they can see within 20 feet of them as a bonus action.",
    effect: { on: "caster", name: "Blink Step (bonus action, 20 ft)", ...MIN }
  },
  44: { text: "The spell ricochets off the target to a random creature within 30 feet of them." },
  45: { text: "Levitate is cast on the caster.", spell: { name: "Levitate" } },
  46: { text: "Caster's money cycles: copper becomes silver, silver becomes gold, gold becomes copper.", cycleCurrency: true },
  47: { text: "A unicorn appears within 5 feet of the caster; after 1 minute it explodes into squirrels which scurry away." },
  48: {
    text: "One of the target's eyes is replaced by a 500 GP sapphire.",
    effect: { on: "target", name: "Sapphire Eye" }
  },
  49: {
    text: "Caster cannot speak; they emit pink bubbles instead for the next minute. They cannot provide verbal components.",
    effect: { on: "caster", name: "Pink Bubbles (no verbal components)", ...MIN }
  },
  50: {
    text: "Smoke fumes from the caster's ears for 1 minute.",
    effect: { on: "caster", name: "Smoking Ears", ...MIN }
  },
  51: {
    text: "A spectral shield follows the caster for 1 minute: +2 AC, and they cannot be targeted by Magic Missile.",
    effect: { on: "caster", name: "Spectral Shield", ...MIN, changes: [{ key: "system.attributes.ac.bonus", mode: 2, value: "+2" }] }
  },
  52: {
    text: "Caster gains a 3-foot-long prehensile tail for 1 hour. If they already have a tail, it grows 3 feet longer for 1 hour.",
    effect: { on: "caster", name: "Prehensile Tail", ...HOUR }
  },
  53: {
    text: "Caster glimpses the Plane of Chaos. Their spellcasting ability score is reduced by 1 for 1 minute.",
    effect: { on: "caster", name: "Glimpse of Chaos", ...MIN, spellcastingPenalty: 1 }
  },
  54: { text: "All unlocked doors and windows within 60 feet fly open." },
  55: {
    text: "Caster's hair falls out, and grows back within 24 hours.",
    effect: { on: "caster", name: "Bald", ...DAY }
  },
  56: { text: "An imp appears in an unoccupied space within 5 feet of the caster and attacks them with its stinger before vanishing at the start of the caster's next turn." },
  57: {
    text: "For 1 minute, flammable objects the caster touches that are not worn or carried by a creature ignite.",
    effect: { on: "caster", name: "Igniting Touch", ...MIN }
  },
  58: {
    text: "A geyser lifts the caster 50 feet into the air. At the start of their next turn, it gently places them back on the ground.",
    effect: { on: "caster", name: "On a Geyser (50 ft up)", ...ROUND }
  },
  59: { text: "Caster regains {mana} mana.", rolls: { mana: "1d6+1" }, mana: "mana" },
  60: { text: "A confused, docile bear appears within 60 feet for 1 minute before burrowing underground to safety." },
  61: {
    text: "For 1 minute, the target can only shout when speaking.",
    effect: { on: "target", name: "Can Only Shout", ...MIN }
  },
  62: { text: "Grass instantly sprouts to 3 feet tall within 20 feet of the caster." },
  63: { text: "Fog Cloud is cast centered on the caster.", spell: { name: "Fog Cloud" } },
  64: {
    text: "Caster can only breathe underwater for the next minute.",
    effect: { on: "caster", name: "Water Breathing Only", ...MIN }
  },
  65: {
    text: "Up to 3 different creatures of the caster's choice within 30 feet of them take 4d10 lightning damage.",
    damage: { formula: "4d10", type: "lightning" }
  },
  66: {
    text: "Target falls unconscious until the start of their next turn or until they take damage.",
    effect: { on: "target", name: "Surge Slumber", ...ROUND, statuses: ["unconscious"] }
  },
  67: {
    text: "Target is frightened of the nearest creature until the end of their next turn.",
    effect: { on: "target", name: "Surge Fright", rounds: 1, turns: 1, seconds: 12, statuses: ["frightened"] }
  },
  68: {
    text: "Caster must make a DC 15 Constitution saving throw. On a failure, their nose begins to bleed harmlessly. They can repeat the save at the start of each of their turns.",
    save: { ability: "con", dc: 15 }
  },
  69: {
    text: "Everyone within 30 feet of the caster becomes invisible for 1 minute or until they make an attack or cast a spell.",
    effect: { on: "area", center: "caster", radius: 30, includeCenter: true, name: "Surge Invisibility", ...MIN, statuses: ["invisible"] }
  },
  70: { text: "All creatures within 60 feet of the caster must succeed on a DC 15 Wisdom saving throw or drop whatever they are holding." },
  71: {
    text: "Caster and one random ally within 30 feet ({ally}) gain resistance to all damage for the next minute.",
    effect: { on: "randomAlly", radius: 30, name: "Chaotic Resilience", ...MIN, resistAll: true }
  },
  72: { text: "Everything within 20 feet of the target is pulled 10 feet toward the caster." },
  73: {
    text: "A random creature within 60 feet of the target ({victim}) is poisoned until it finishes a long rest.",
    effect: { on: "randomNear", center: "target", radius: 60, name: "Surge Poison (until long rest)", statuses: ["poisoned"] }
  },
  74: {
    text: "Caster smells like lavender for {days} days.",
    rolls: { days: "1d6" },
    effect: { on: "caster", name: "Lavender Scent", secondsPer: { days: 86400 } }
  },
  75: {
    text: "Caster emits bright light out to 40 feet and dim light for an additional 20 feet for 1 minute. Any creature within 5 feet of the caster must succeed on a DC 15 Constitution saving throw or be blinded until the start of their next turn.",
    effect: { on: "caster", name: "Radiant Glow", ...MIN }
  },
  76: {
    text: "Caster's clothes become uncomfortably tight.",
    effect: { on: "caster", name: "Tight Clothes" }
  },
  77: { text: "Polymorph is cast on the caster. If they fail the save, they turn into a goat.", spell: { name: "Polymorph" } },
  78: { text: "If the spell would kill its target, the target's extremities fly apart." },
  79: {
    text: "Illusory butterflies and flowers flutter and sprout in a 5-foot radius around the caster for 1 minute.",
    effect: { on: "caster", name: "Butterflies and Flowers", ...MIN }
  },
  80: {
    text: "Caster is trapped in a giant glass ball (AC 18, 20 HP). They have total cover, their speed becomes 40 ft but they can only move in a straight 40-foot line each time, and they cannot target anything outside the ball with attack rolls or Dexterity, Constitution or Strength saving throws.",
    effect: { on: "caster", name: "Glass Ball (AC 18, 20 HP)" }
  },
  81: { text: "Caster can immediately take one additional action.", grant: { action: 1 } },
  82: {
    text: "Caster's fists become otherworldly tentacles with a reach of 20 feet for 1 minute. On a hit, they deal 2d8 + spellcasting modifier bludgeoning damage.",
    effect: { on: "caster", name: "Tentacle Fists", ...MIN },
    damage: { formula: "2d8 + @mod", type: "bludgeoning" }
  },
  83: {
    text: "All creatures within 30 feet of the target take 1d10 necrotic damage. Undead and constructs are immune. The caster regains HP equal to the total damage dealt.",
    damage: { formula: "1d10", type: "necrotic" }
  },
  84: {
    text: "A loud voice ridicules the caster on initiative count 20 for 1 minute.",
    effect: { on: "caster", name: "Ridiculed", ...MIN }
  },
  85: { text: "Caster sneezes and 3 illusory duplicates appear (Mirror Image is cast on them).", spell: { name: "Mirror Image" } },
  86: {
    text: "Caster's legs become frog legs for 1 minute. Their standing long jump is up to 20 ft and their standing high jump up to 10 ft.",
    effect: { on: "caster", name: "Frog Legs", ...MIN }
  },
  87: { text: "Fly is cast on a random creature within 60 feet of the caster ({flier}).", spell: { name: "Fly" }, randomFlier: 60 },
  88: {
    text: "A large, floating eye follows the caster for 1 hour.",
    effect: { on: "caster", name: "Floating Eye", ...HOUR }
  },
  89: {
    text: "Target becomes invisible and silent until the start of their next turn or until they attack or cast a spell.",
    effect: { on: "target", name: "Invisible and Silent", ...ROUND, statuses: ["invisible"] }
  },
  90: {
    text: "Caster's Intelligence and Strength scores swap for 1 hour.",
    effect: { on: "caster", name: "Swapped INT and STR", ...HOUR, swapAbilities: ["int", "str"] }
  },
  91: {
    text: "If the caster dies within the next day, they become the target of a Reincarnate spell. They gain their new body after 8 hours.",
    effect: { on: "caster", name: "Destined to Reincarnate", ...DAY }
  },
  92: {
    text: "Caster sees everyone as a decaying corpse for the next 24 hours.",
    effect: { on: "caster", name: "Corpse Vision", ...DAY }
  },
  93: {
    text: "Caster's size increases by one category for 1 minute (even if they are under the effects of Enlarge/Reduce).",
    effect: { on: "caster", name: "Surge Growth", ...MIN }
  },
  94: { text: "All light sources within a 60-foot radius are extinguished." },
  95: {
    text: "Caster and everyone within 30 feet of them become vulnerable to piercing damage for 1 minute.",
    effect: {
      on: "area", center: "caster", radius: 30, includeCenter: true, name: "Piercing Vulnerability", ...MIN,
      changes: [{ key: "system.traits.dv.value", mode: 2, value: "piercing" }]
    }
  },
  96: {
    text: "Caster becomes frightened of the colour {color} for 1 hour.",
    pick: { color: SURGE_COLORS },
    effect: { on: "caster", name: "Fear of a Colour", ...HOUR }
  },
  97: {
    text: "Caster is surrounded by faint ethereal music for 1 minute.",
    effect: { on: "caster", name: "Ethereal Music", ...MIN }
  },
  98: { text: "Caster regains mana equal to their Sorcerer level ({mana}).", mana: "sorcererLevel" },
  99: { text: "Leomund's Tiny Hut is cast centered on the caster.", spell: { name: "Leomund's Tiny Hut", alt: ["Tiny Hut"] } },
  100: {
    text: "Caster is temporarily banished to the Plane of Chaos. They return at the start of their next turn but lose {lost} mana.",
    rolls: { lost: "1d8+2" },
    effect: { on: "caster", name: "Banished to Chaos", ...ROUND },
    mana: "-lost"
  }
};
