// One-time (re-runnable) import of Built Trailers' real dealer network into the customer table for
// the public dealer locator. Upserts by name: existing dealers are updated, new ones inserted as
// active Dealership customers. Coordinates are pre-geocoded (via OpenStreetMap) and baked in, so
// the import is instant and offline. Any dealer with null coordinates is geocode-resistant (new
// development / highway address) — set those by hand in Customers & Dealers → 📍 Address.
//
//   Run against production:  DATABASE_URL=<prod-url> node scripts/import-dealers.js
//   (or in the Render shell:  node scripts/import-dealers.js)
//
// Idempotent — safe to re-run.
import { initDb, q, one } from '../src/db.js';
import { ensureSchema } from '../db/migrate.js';

// name, street, city, state, zip, phone ('' = unknown, add later), lat, lng (null = set manually)
const DEALERS = [
  ['ProShop Motorsports & Marine', '575 W Lake Mead Pkwy', 'Henderson', 'NV', '89015', '(702) 564-8895', 36.0354278, -114.9998333],
  ['Boating Lake Mead - Dry Dock', '4290 Boulder Hwy', 'Las Vegas', 'NV', '89121', '(702) 451-2992', 36.1430861, -115.0986979],
  ['Trailer Source Las Vegas', '3112 N Nellis Blvd', 'Las Vegas', 'NV', '89115', '(702) 413-7900', 36.1924689, -115.062253],
  ['Anderson Powersports Bullhead', '1017 AZ-95', 'Bullhead City', 'AZ', '86429', '(928) 754-5475', 35.1521335, -114.5677941],
  ['Anderson Powersports Parker', '800 S California Ave', 'Parker', 'AZ', '85344', '(928) 669-2549', 34.1494196, -114.2885242],
  ['Anderson Powersports Havasu', '1040 N Lake Havasu Ave', 'Lake Havasu City', 'AZ', '86403', '(928) 453-1610', 34.504238, -114.3478653],
  ['Northern Colorado Powersports', '1303 SW Frontage Rd', 'Fort Collins', 'CO', '80524', '(970) 679-1600', 40.5709475, -105.0023265],
  ['Elevated Marine', '5889 N Lamar St', 'Arvada', 'CO', '80003', '(303) 390-1390', 39.8426707, -105.0695012],
  ['Young Powersports XL', '547 S Frontage Rd', 'Centerville', 'UT', '84014', '(801) 486-5401', 40.9182463, -111.8905857],
  ['Factory Powersports St. George', '1685 E Red Hills Pkwy', 'St. George', 'UT', '84770', '(435) 628-5281', 37.1339421, -113.6022545],
  ['Moto United St. George', '4646 S Desert Color Pkwy', 'St. George', 'UT', '84790', '(435) 652-2640', 37.0274022, -113.600576],
  ['Marine United', '4646 S Desert Color Pkwy', 'St. George', 'UT', '84790', '(435) 610-2628', 37.0274022, -113.600576],
  ['Nautique / Yamaha Boats of Utah', '12645 Minuteman Dr A', 'Draper', 'UT', '84020', '(801) 984-3100', 40.5212839, -111.8905672],
  ['Trailer Source Hurricane', '6064 W State St', 'Hurricane', 'UT', '84737', '(435) 627-1633', 37.1618502, -113.4281902],
  ['Trailer Source Cedar City', '1145 N Main St', 'Cedar City', 'UT', '84721', '(435) 867-1990', 37.6980081, -113.0637148],
  ['Factory Powersports Las Vegas', '7202 S Jones Blvd', 'Las Vegas', 'NV', '89118', '(702) 260-3366', 36.1442349, -115.2251831],
  ['Marine United - Lehi', '411 Millpond Dr', 'Lehi', 'UT', '84043', '(801) 568-6686', 40.3816277, -111.8324429],
  ['Moto United - Lehi', '411 Millpond Dr', 'Lehi', 'UT', '84043', '(801) 568-6686', 40.3816277, -111.8324429],
  ['Moto United Draper', '98 E 13800 S', 'Draper', 'UT', '84020', '(801) 572-6720', 40.5007131, -111.8826361],
  ['Marine United Draper', '98 E 13800 S', 'Draper', 'UT', '84020', '(801) 572-6720', 40.5007131, -111.8826361],
  ['Marine United Salt Lake', '2651 S 600 W', 'Salt Lake City', 'UT', '84115', '(801) 568-6686', 40.7508434, -111.908093],
  ['Honda Powerhouse', '461 S Frontage Rd', 'Centerville', 'UT', '84014', '', 40.930968, -111.8907675],
  ['Young Powersports Pleasant View', '2529 N Hwy 89', 'Pleasant View', 'UT', '84414', '', null, null],
  ['Young Powersports Ogden', '3745 S 250 W', 'Ogden', 'UT', '84405', '', 41.1960461, -111.9838075],
  ['Young Powersports Missoula', '5106 East Harrier', 'Missoula', 'MT', '59808', '', 46.9214698, -114.0683463],
  ['Young Powersports Morgan', '800 E 100 S', 'Morgan', 'UT', '84050', '', 41.0364967, -111.667211],
  ['Young Powersports Logan', '1903 S 800 W', 'Logan', 'UT', '84321', '', 41.6975584, -111.8541277],
  ['Young Powersports Layton', '60 N Main St', 'Layton', 'UT', '84041', '', 41.0809369, -111.9904494],
  ['Young Powersports Burley', '333 Overland Ave', 'Burley', 'ID', '83318', '', 42.5592028, -113.7930158],
  ['Factory Powersports Santa Rosa', '55 College Ave', 'Santa Rosa', 'CA', '95401', '(707) 545-1672', 38.4461807, -122.7269994],
];

async function run() {
  await initDb();
  await ensureSchema();
  let added = 0, updated = 0; const noCoords = [];
  for (let i = 0; i < DEALERS.length; i++) {
    const [name, address, city, state, zip, phone, lat, lng] = DEALERS[i];
    if (lat == null) noCoords.push(name);
    const existing = await one('SELECT id FROM customer WHERE lower(name)=lower($1)', [name]);
    if (existing) {
      await q(`UPDATE customer SET kind='Dealership', active=true, address=$1, city=$2, state=$3, zip=$4,
               phone=COALESCE(NULLIF($5,''), phone), lat=$6, lng=$7 WHERE id=$8`,
        [address, city, state, zip, phone, lat, lng, existing.id]);
      updated++;
    } else {
      const id = 'c' + Date.now() + '-' + i;
      await q(`INSERT INTO customer(id,name,kind,active,address,city,state,zip,phone,lat,lng)
               VALUES($1,$2,'Dealership',true,$3,$4,$5,$6,$7,$8,$9)`,
        [id, name, address, city, state, zip, phone || null, lat, lng]);
      added++;
    }
  }
  console.log(`Done — ${added} added, ${updated} updated, ${DEALERS.length - noCoords.length}/${DEALERS.length} on the map.`);
  if (noCoords.length) console.log(`Set coordinates by hand (Customers & Dealers -> the dealer's address editor): ${noCoords.join(', ')}`);
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
