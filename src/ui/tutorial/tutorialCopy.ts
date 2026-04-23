/** Strings for the first-run guided tour (English v1). */
export const TUTORIAL_COPY: Record<string, { title: string; body: string }> = {
  intro: {
    title: 'Welcome to Idle Craft',
    body: 'Take a short guided tour of survival, automation, and tabs — or skip if you already know idle deck games.',
  },
  hud_meters: {
    title: 'Stay alive',
    body: 'Watch HP, hunger, thirst, and mana in the bar above. Hunger and thirst fall over time — gather food and water before they hit zero.',
  },
  nav_tabs: {
    title: 'Tabs',
    body: 'Along the top: Gather, Craft, Inventory, Decks, Idle, RPG (harvest mastery), Battle, Hire, and Portal. The tour covers survival, automation, progression, and the webring exit.',
  },
  gather_water: {
    title: 'Gather water',
    body: 'Open manual gathering and collect water when you can. Long clips play in the dock — plan ahead while thirst is still safe.',
  },
  gather_berries: {
    title: 'Gather berries',
    body: 'Berries help with hunger. Stock a little of everything you need for crafting and eating.',
  },
  idle_tab: {
    title: 'Idle automation',
    body: 'Automation runs while the game is open in this browser. (Full offline idling may come later.) Idle lines stack with helpers up to a bonus cap.',
  },
  idle_windfall: {
    title: 'Fill slots with Windfall trail',
    body: 'Assign Windfall trail to every automation slot (six times). It passively adds fiber and berries so your lines are never empty — replace with stronger cards when you unlock them.',
  },
  decks_tab: {
    title: 'Decks',
    body: 'Unlock cards with coin and requirements. Cards open recipes, stations, magic, and combat options. Build toward camp (campfire blueprint), magic (Wild awakening path), and combat cards as you grow.',
  },
  craft_tab: {
    title: 'Craft',
    body: 'Recipes appear per station — Hand, Campfire, Workbench, Forge, Kitchen. Craft tools, structures, and food using what you have in camp.',
  },
  inventory_tab: {
    title: 'Inventory',
    body: 'Everything you own lives here. Food and water you gather or cook show up as counts you can use from other tabs.',
  },
  battle_tab: {
    title: 'Battle',
    body: 'Turn-based fights use the same HP, hunger, and thirst as the world. Start an encounter when you are ready — 0 HP ends the run (permadeath in PvE).',
  },
  battle_combat_tip: {
    title: 'In combat',
    body: 'Spend energy on cards in your combat deck. When it is your turn after acting, use End turn (enemy acts) in PvE. Bandages and stims use a turn but can save you.',
  },
  hire_tab: {
    title: 'Hire',
    body: 'Helpers cost coin and upkeep. They boost idle speed (capped), passively gather, and some feed you from stockpile or help in battle.',
  },
  rpg_tab: {
    title: 'Harvest mastery (RPG)',
    body: 'Spend coin on each manual vein: pathfinding pulls resources closer in the dock (shorter walks and faster gather clips), bounty increases yields, and regrowth sense speeds node respawns and lowers strain. Harvesting stresses a vein — at max strain it seals and stops respawning for this run.',
  },
  gather_merchant: {
    title: 'Wandering merchant',
    body: 'On Gather, the caravan panel shows when the next visit is or how long the merchant stays. While they are here, sell surplus resources for coin and buy special bundles or rare deck charters. Coin also comes from battles and manual gathers.',
  },
  gather_again: {
    title: 'Keep gathering',
    body: 'Between crafts and fights, use Gather to refill water, food, and materials so automation and recipes stay fed — and check the merchant when their timer hits zero.',
  },
  portal_tab: {
    title: 'Portal',
    body: 'The last tab in the bar is the webring / jam exit. Open it when you want to leave for another game — your character walks into the ring in the dock. You are not switched there automatically.',
  },
  esc_camera: {
    title: 'Menu & camera',
    body: 'Press Esc (or the Esc button on small screens) for the system menu — audio, music, and camera help (orbit, pan, zoom on the 3D dock). Double-click the dock resets the view. Next: graphics and lighting in the same menu.',
  },
  esc_graphics: {
    title: 'Graphics & lighting',
    body: 'The Esc menu is open: scroll to Post-processing (FXAA, bloom, SSAO, vignette) and Lighting & color (exposure, sun, ambient, moon). Turn on “Show explanations for graphics & lighting” anytime for a short tip under each control — you can switch it off in this menu once you know the knobs.',
  },
  done: {
    title: 'Tutorial complete',
    body: 'You are set. Experiment with deck order, idle lines, hires, and harvest mastery — sell to the caravan when it visits, and keep thirst and hunger in check.',
  },
};
