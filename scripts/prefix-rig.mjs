import fs from 'fs';
let s = fs.readFileSync('src/visual/_dock_transformed.txt', 'utf8');
const names = [
  'trunkUnderMesh',
  'trunkJerkinMesh',
  'forgeWifeLipMat',
  'forgeWifeIrisMat',
  'forgeWifeTorsoRoot',
  'forgeWifeOverlayRoot',
  'lpcaShPadL',
  'lpcaShPadR',
  'lpcaNeck',
  'lpcaCranium',
  'lpcaJaw',
  'lpcaChin',
  'lpcaCheekL',
  'lpcaCheekR',
  'lpcaDefaultHair',
  'lpcaArtisanHair',
  'vanguardStaffWoodMat',
  'vanguardStaffGemMat',
  'vanguardWizardRobeRoot',
  'vanguardWizardHatRoot',
  'vanguardWizardStaffRoot',
  'forgeWifeHeadRoot',
  'legLMesh',
  'legRMesh',
  'footLMesh',
  'footRMesh',
  'armL',
  'armR',
];
for (const n of names) {
  const re = new RegExp(`\\b${n}\\b`, 'g');
  s = s.replace(re, `rig.${n}`);
}
s = s.replace(/rig\.rig\./g, 'rig.');
fs.writeFileSync('src/visual/_dock_rig.txt', s);
