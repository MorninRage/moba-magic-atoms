/**
 * NPC / secondary wizard visuals — legacy hat wizard vs playable sage (hood) build.
 * Merchant and future camp NPCs can spawn `legacy_hat_wizard` without affecting `CharacterPresetId`.
 */
export type NpcWizardVisualKind = 'legacy_hat_wizard' | 'sage_hood_wizard';

/** Default for Gather merchant portrait tier “medium” 3D when wired — use legacy for familiar silhouette. */
export const MERCHANT_NPC_WIZARD_VISUAL: NpcWizardVisualKind = 'legacy_hat_wizard';
