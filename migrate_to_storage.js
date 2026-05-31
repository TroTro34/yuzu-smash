'use strict';

/**
 * Migration script — base64 → Supabase Storage
 * 
 * Migrates existing base64-encoded images stored in the DB to Supabase Storage.
 * Safe to run multiple times (skips already-migrated entries).
 *
 * Tables migrated:
 *   - banners      → img_dash, img_lb, img_dash_gif, img_lb_gif
 *   - reports      → screenshot
 *   - whatsup_posts → image
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_KEY=service_role_key node migrate_to_storage.js
 */

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BUCKET       = 'yuzu-assets';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌  Missing SUPABASE_URL or SUPABASE_KEY env vars');
  process.exit(1);
}

// ── Supabase DB helpers ───────────────────────────────────────────────────────

function sbHeaders() {
  return {
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation',
  };
}

async function sbGet(table, params = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`sbGet ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbPatch(table, match, data) {
  const params = Object.entries(match).map(([k, v]) => `${k}=eq.${v}`).join('&');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`sbPatch ${table}: ${r.status} ${await r.text()}`);
}

// ── Storage helpers ───────────────────────────────────────────────────────────

async function uploadToStorage(buffer, mimeType, folder, filename) {
  const path = `${folder}/${filename}`;
  const r = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
    {
      method:  'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  mimeType,
        'x-upsert':      'true',
      },
      body: buffer,
    }
  );
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Storage upload failed (${r.status}): ${err}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

// ── Base64 helpers ────────────────────────────────────────────────────────────

function isBase64(val) {
  return val && typeof val === 'string' && val.startsWith('data:image/');
}

function isUrl(val) {
  return val && typeof val === 'string' && val.startsWith('http');
}

function parseBase64(val) {
  const [header, b64] = val.split(',');
  const mime = header.replace('data:', '').replace(';base64', '');
  const buffer = Buffer.from(b64, 'base64');
  const ext = mime === 'image/gif'  ? 'gif'
            : mime === 'image/png'  ? 'png'
            : mime === 'image/webp' ? 'webp' : 'jpg';
  return { mime, buffer, ext };
}

// ── Migration logic ───────────────────────────────────────────────────────────

let totalMigrated = 0;
let totalSkipped  = 0;
let totalErrors   = 0;

async function migrateField(table, row, idField, field, folder, filenamePrefix) {
  const val = row[field];
  if (!val) return;           // empty — nothing to do
  if (isUrl(val)) { totalSkipped++; return; }  // already a URL
  if (!isBase64(val)) return; // unknown format — skip

  try {
    const { mime, buffer, ext } = parseBase64(val);
    const filename = `${filenamePrefix}_${field}.${ext}`;
    const url = await uploadToStorage(buffer, mime, folder, filename);
    await sbPatch(table, { [idField]: row[idField] }, { [field]: url });
    console.log(`  ✅ ${table}.${field} [${row[idField]}] → ${url.slice(-60)}`);
    totalMigrated++;
  } catch (e) {
    console.error(`  ❌ ${table}.${field} [${row[idField]}]: ${e.message}`);
    totalErrors++;
  }
}

async function migrateBanners() {
  console.log('\n📦 Migrating banners…');
  const banners = await sbGet('banners', 'select=id,img_dash,img_lb,img_dash_gif,img_lb_gif');
  console.log(`   Found ${banners.length} banners`);
  for (const b of banners) {
    for (const field of ['img_dash', 'img_lb', 'img_dash_gif', 'img_lb_gif']) {
      await migrateField('banners', b, 'id', field, 'banners', b.id);
    }
  }
}

async function migrateReports() {
  console.log('\n🚩 Migrating report screenshots…');
  // Only fetch reports that have a screenshot (avoid loading the whole table)
  const reports = await sbGet('reports', 'select=id,screenshot&screenshot=not.is.null');
  const withScreenshot = reports.filter(r => isBase64(r.screenshot));
  console.log(`   Found ${reports.length} reports, ${withScreenshot.length} with base64 screenshot`);
  for (const rep of withScreenshot) {
    await migrateField('reports', rep, 'id', 'screenshot', 'reports', rep.id);
  }
}

async function migrateWhatsup() {
  console.log('\n📢 Migrating whatsup_posts images…');
  const posts = await sbGet('whatsup_posts', 'select=id,image&image=not.is.null');
  const withImage = posts.filter(p => isBase64(p.image));
  console.log(`   Found ${posts.length} posts, ${withImage.length} with base64 image`);
  for (const post of withImage) {
    await migrateField('whatsup_posts', post, 'id', 'image', 'whatsup', post.id);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Starting migration to Supabase Storage');
  console.log(`   Supabase: ${SUPABASE_URL}`);
  console.log(`   Bucket:   ${BUCKET}`);

  await migrateBanners();
  await migrateReports();
  await migrateWhatsup();

  console.log('\n─────────────────────────────────────');
  console.log(`✅ Migrated : ${totalMigrated}`);
  console.log(`⏭  Skipped  : ${totalSkipped} (already URLs)`);
  console.log(`❌ Errors   : ${totalErrors}`);
  console.log('─────────────────────────────────────');

  if (totalErrors > 0) {
    console.log('\n⚠  Some fields failed. Re-run the script to retry them.');
    process.exit(1);
  } else {
    console.log('\n🎉 Migration complete!');
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
