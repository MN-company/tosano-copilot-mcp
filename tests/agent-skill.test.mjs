import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {RELEASE, REQUIRED_TOOLS} from '../src/release-contract.mjs';
const file=fs.readFileSync(new URL('../integrations/chatgpt/skills/tosano-shopping/SKILL.md',import.meta.url),'utf8');
test('app skill uses current release and capability-gates fresh tool catalog',()=>{
 assert.ok(file.startsWith('---\nname: tosano-shopping\n'));
 assert.ok(file.includes('v0.5.x'));
 assert.ok(file.includes(RELEASE.mcpContract));
 assert.ok(file.includes('Refresh/Reconnect'));
 assert.ok(file.includes('TWO_PHASE_REQUIRED'));
 for(const key of ['tosano_smart_search','tosano_preference_upsert','tosano_profile_status','tosano_dietary_rule_add','tosano_prepare_cart_change','tosano_commit_cart_change','tosano_site_lists','tosano_prepare_site_action','tosano_commit_site_action','tosano_checkout_preview','tosano_meal_plan_suggest','tosano_household_member_add','tosano_usual_items']) assert.ok(file.includes(key));
});
