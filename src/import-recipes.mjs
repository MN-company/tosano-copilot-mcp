/** Fill the local recipe database. Usage: node src/import-recipes.mjs [wikibooks] [themealdb] */
import { RecipeStore, importWikibooks, importTheMealDB } from './recipe-db.mjs';

const want = process.argv.slice(2).length ? process.argv.slice(2) : ['wikibooks', 'themealdb'];
const store = new RecipeStore(process.env.RECIPES_DB || undefined);
const log = m => console.log(m);
if (want[0] === 'reenrich') { console.log(store.reenrichAll()); want.length = 0; }
for (const s of want) {
  if (s === 'wikibooks') console.log(await importWikibooks(store, { log }));
  else if (s === 'themealdb') console.log(await importTheMealDB(store, { log, apiKey: process.env.THEMEALDB_API_KEY || '1' }));
  else console.error('Unknown source', s);
}
console.log(JSON.stringify(store.stats().bySource));
