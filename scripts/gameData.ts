import * as fs from 'fs';
import * as path from 'path';

const PROJECT_DIR = path.resolve(__dirname, '..');
const SCENES_DIR = path.join(PROJECT_DIR, 'scenes');
const RECIPES_DIR = path.join(PROJECT_DIR, 'recipes');
const ENTITIES_DIR = path.join(PROJECT_DIR, 'entities');

export interface GameProject {
  name: string;
  version: string;
  engine: string;
  activeScene: string;
  config: Record<string, number | string | boolean>;
  time: number;
  weather: { type: string; intensity: number };
}

export interface SceneFile {
  name: string;
  description: string;
  camera: { position: number[]; target: number[] };
  time: number;
  weather: { type: string; intensity: number };
  entities: EntityDef[];
}

export interface EntityDef {
  id: string;
  tags: string[];
  position: [number, number, number];
  components: Record<string, any>;
  recipe?: string;
}

export interface RecipeDef {
  name: string;
  layers: Array<{ name: string; steps: any[] }>;
}

export function loadProject(): GameProject {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.json'), 'utf-8'));
}

export function saveProject(project: GameProject): void {
  fs.writeFileSync(path.join(PROJECT_DIR, 'project.json'), JSON.stringify(project, null, 2), 'utf-8');
}

export function loadScene(sceneName: string): SceneFile {
  return JSON.parse(fs.readFileSync(path.join(SCENES_DIR, sceneName + '.json'), 'utf-8'));
}

export function saveScene(sceneName: string, scene: SceneFile): void {
  fs.writeFileSync(path.join(SCENES_DIR, sceneName + '.json'), JSON.stringify(scene, null, 2), 'utf-8');
}

export function listScenes(): string[] {
  return fs.readdirSync(SCENES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
}

export function loadRecipe(recipeName: string): RecipeDef {
  return JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, recipeName + '.json'), 'utf-8'));
}

export function saveRecipe(recipeName: string, recipe: RecipeDef): void {
  fs.writeFileSync(path.join(RECIPES_DIR, recipeName + '.json'), JSON.stringify(recipe, null, 2), 'utf-8');
}

export function listRecipes(): string[] {
  return fs.readdirSync(RECIPES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
}

export function addEntityToScene(sceneName: string, entity: EntityDef): void {
  const scene = loadScene(sceneName);
  scene.entities.push(entity);
  saveScene(sceneName, scene);
}

export function removeEntityFromScene(sceneName: string, entityId: string): void {
  const scene = loadScene(sceneName);
  scene.entities = scene.entities.filter(e => e.id !== entityId);
  saveScene(sceneName, scene);
}

export function generateEntityId(): string {
  return 'ent_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}
