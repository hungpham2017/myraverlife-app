// Raw POI list pasted from _pois.html on 2026-05-08.
// Source of truth — DO NOT edit by hand. Normalization rules go elsewhere
// so we can re-run them if the picker is re-paste-ed.
//
// Issues to address before merging into MAP_POIS in index.html:
//
//   1. Stage names — promoted from type:'custom' to type:'stage' and
//      renamed to the two-word display form (matches the displayName
//      field in festival.config.js so the search & lineup show the same
//      thing). When merging into MAP_POIS in index.html, also attach
//      `color` (e.g. '#ff5aa0') and `tags` so the popup CTA renders the
//      brand-color "View lineup →" button. Map from displayName back to
//      stage `id` via STAGES.find(s => s.displayName === poi.name).id.
//
//   2. Typos to fix:
//        'Momads Portal'    → 'Nomads Portal'
//        'Savage City'      → 'Salvage City'      (per Insomniac artwork)
//        'Insomniac Friday' → 'Insomniac Fridays'
//        'Flower Towel'     → 'Flower Tunnel'    (likely)
//        'Casa Bacardi'     → 'Casa Bacardí'
//        'circuitGrounds'   → 'circuitGROUNDS'
//        'lunchbox Packs'   → 'Lunchbox Packs'   (capitalization)
//
//   3. Duplicates / merges:
//        Multiple Photo Op, Restrooms, Info, VIP, etc. — these are real
//        (each section has its own). Keep all, but consider deduping by
//        proximity if any are <2% apart.
//
//   4. Custom → preset opportunities:
//        Things tagged 'custom' that could probably map to a preset cat:
//          'Gate S' / 'Gates C/D' / 'Gate P'  → no preset for gates yet
//          'PLUR' / 'Insomniac Radio' / 'Zero Gravity' / 'Bamboo Village'
//          / 'Crazy Dumbo' / 'Vertigo' / 'Wave Swinger' / 'Star fighter'
//          → these are rides / venues / activations; legend has no
//             matching preset, so 'custom' is correct for them.
//
//   5. Stage tap-targets currently sit a few % off from the OCR positions
//      (which were better-centered on the artwork's stage label). User's
//      manual placements are intentional — they may be aimed at the
//      stage's main entrance / centroid, not the painted text.

const RAW_POIS = [
    { type:'vip-water-stations', name:'VIP Water Stations', mapPct:{left:53.77, top:14.95} },
    { type:'vip-concierge', name:'VIP Concierge', mapPct:{left:56.34, top:14.93} },
    { type:'photo-op', name:'Photo Op', mapPct:{left:58.24, top:16.3} },
    { type:'vip-restrooms', name:'VIP Restrooms', mapPct:{left:60.14, top:18.03} },
    { type:'merchandise', name:'Merchandise', mapPct:{left:55.53, top:17.89} },
    { type:'kandi-station', name:'Kandi Station', mapPct:{left:56.7, top:19.77} },
    { type:'trinket-trade', name:'Trinket Trade', mapPct:{left:54.26, top:19.7} },
    { type:'water-stations', name:'Water Stations', mapPct:{left:63.95, top:22.02} },
    { type:'lockers', name:'Lockers', mapPct:{left:55.89, top:26.22} },
    { type:'vip', name:'VIP', mapPct:{left:53.44, top:25.79} },
    { type:'vip-viewing-deck', name:'VIP Viewing Deck', mapPct:{left:49.78, top:19.77} },
    { type:'marquee-skydeck', name:'Marquee Skydeck', mapPct:{left:37.32, top:20.86} },
    { type:'photo-op', name:'Photo Op', mapPct:{left:38.77, top:22.45} },
    { type:'accessible-viewing', name:'Accessible Viewing', mapPct:{left:37.95, top:16.44} },
    { type:'restrooms', name:'Restrooms', mapPct:{left:24.09, top:16.01} },
    { type:'first-aid', name:'First Aid', mapPct:{left:22.74, top:17.96} },
    { type:'ground-control', name:'Ground Control Oasis', mapPct:{left:20.92, top:19.41} },
    { type:'custom', name:'PLUR', mapPct:{left:18.39, top:21.44} },
    { type:'custom', name:'Insomniac Radio', mapPct:{left:15.85, top:23.9} },
    { type:'restrooms', name:'Restrooms', mapPct:{left:13.32, top:27.09} },
    { type:'custom', name:'VIP CENTURY WHEEL', mapPct:{left:58.12, top:22.31} },
    { type:'first-aid', name:'First Aid', mapPct:{left:68.57, top:27.09} },
    { type:'custom', name:'Zero Gravity', mapPct:{left:33.7, top:20.06} },
    { type:'custom', name:'Flower Tunnel', mapPct:{left:40.76, top:33.47} },
    { type:'charging-station', name:'Charging Station', mapPct:{left:43.21, top:79.7} },
    { type:'accessible-viewing', name:'Accessible Viewing', mapPct:{left:40.85, top:82.09} },
    { type:'vip', name:'VIP', mapPct:{left:27.45, top:89.27} },
    { type:'lockers', name:'Lockers', mapPct:{left:24.97, top:91.12} },
    { type:'vip-water-stations', name:'VIP Water Stations', mapPct:{left:27.26, top:92.09} },
    { type:'vip-restrooms', name:'VIP Restrooms', mapPct:{left:22.92, top:89.99} },
    { type:'restrooms', name:'Restrooms', mapPct:{left:20.38, top:88.4} },
    { type:'first-aid', name:'First Aid', mapPct:{left:13.77, top:79.27} },
    { type:'ground-control', name:'Ground Control Oasis', mapPct:{left:12.41, top:76.01} },
    { type:'accessible-viewing', name:'Accessible Viewing', mapPct:{left:18.66, top:74.27} },
    { type:'vip-water-stations', name:'VIP Water Stations', mapPct:{left:26.45, top:76.22} },
    { type:'vip', name:'VIP', mapPct:{left:27.9, top:74.7} },
    { type:'first-aid', name:'First Aid', mapPct:{left:52.54, top:78.11} },
    { type:'accessible-viewing', name:'Accessible Viewing', mapPct:{left:55.71, top:76.88} },
    { type:'marquee-skydeck', name:'Marquee Skydeck', mapPct:{left:56.7, top:79.85} },
    { type:'vip-water-stations', name:'VIP Water Stations', mapPct:{left:60.42, top:71.3} },
    { type:'vip-barber', name:'VIP Barber', mapPct:{left:66.58, top:71.95} },
    { type:'vip-restrooms', name:'VIP Restrooms', mapPct:{left:68.48, top:74.99} },
    { type:'vip-concierge', name:'VIP Concierge', mapPct:{left:68.12, top:69.12} },
    { type:'vip-viewing-deck', name:'VIP Viewing Deck', mapPct:{left:65.76, top:69.05} },
    { type:'vip', name:'VIP', mapPct:{left:62.77, top:69.63} },
    { type:'lockers', name:'Lockers', mapPct:{left:70.38, top:69.05} },
    { type:'maverick-heli', name:'Maverick Helicopters', mapPct:{left:51.36, top:76.01} },
    { type:'custom', name:'Gate S', mapPct:{left:71.2, top:23.69} },
    { type:'custom', name:'Gates C/D', mapPct:{left:8.42, top:53.83} },
    { type:'custom', name:'Gate P', mapPct:{left:12.23, top:84.85} },
    { type:'restrooms', name:'Restrooms', mapPct:{left:70.01, top:65.86} },
    { type:'vip', name:'VIP', mapPct:{left:61.59, top:40.79} },
    { type:'vip-water-stations', name:'VIP Water Stations', mapPct:{left:68.93, top:42.38} },
    { type:'vip-restrooms', name:'VIP Restrooms', mapPct:{left:70.11, top:38.03} },
    { type:'photo-op', name:'Photo Op', mapPct:{left:64.58, top:39.77} },
    { type:'vip-concierge', name:'VIP Concierge', mapPct:{left:67.48, top:38.47} },
    { type:'marquee-skydeck', name:'Marquee Skydeck', mapPct:{left:68.21, top:40.5} },
    { type:'accessible-viewing', name:'Accessible Viewing', mapPct:{left:61.59, top:35.5} },
    { type:'vip', name:'VIP', mapPct:{left:67.75, top:34.56} },
    { type:'charging-station', name:'Charging Station', mapPct:{left:43.93, top:54.27} },
    { type:'insomniac-passport', name:'Insomniac Passport', mapPct:{left:44.29, top:51.3} },
    { type:'photo-op', name:'Photo Op', mapPct:{left:44.29, top:47.96} },
    { type:'merchandise', name:'Merchandise', mapPct:{left:41.94, top:46.95} },
    { type:'custom', name:'EDC Downtown', mapPct:{left:35.96, top:54.56} },
    { type:'lockers', name:'Lockers', mapPct:{left:31.16, top:62.6} },
    { type:'cash-exchange', name:'Cash Exchange', mapPct:{left:33.06, top:64.05} },
    { type:'general-store', name:'General Store', mapPct:{left:42.39, top:62.38} },
    { type:'merchandise', name:'Merchandise', mapPct:{left:44.93, top:60.57} },
    { type:'lost-found', name:'Lost & Found', mapPct:{left:30.43, top:48.54} },
    { type:'consciousness-group', name:'Consciousness Group', mapPct:{left:29.53, top:61.44} },
    { type:'info', name:'Info', mapPct:{left:24.55, top:65.64} },
    { type:'info', name:'Info', mapPct:{left:47.19, top:51.88} },
    { type:'info', name:'Info', mapPct:{left:21.2, top:45.28} },
    { type:'water-stations', name:'Water Stations', mapPct:{left:19.66, top:47.45} },
    { type:'vip', name:'VIP', mapPct:{left:17.12, top:45.28} },
    { type:'accessible-viewing', name:'Accessible Viewing', mapPct:{left:13.68, top:57.24} },
    { type:'vip', name:'VIP', mapPct:{left:31.48, top:37.78} },
    { type:'charging-station', name:'Charging Station', mapPct:{left:25.47, top:31.51} },
    { type:'accessible-viewing', name:'Accessible Viewing', mapPct:{left:57.97, top:49.12} },
    { type:'vip', name:'VIP', mapPct:{left:66.38, top:44.56} },
    { type:'custom', name:'Wifi', mapPct:{left:26.18, top:29.56} },
    { type:'custom', name:'Wifi', mapPct:{left:56.7, top:55.35} },
    { type:'custom', name:'Wifi', mapPct:{left:29.44, top:69.27} },
    { type:'custom', name:'Diamond Wheel', mapPct:{left:50.95, top:52.88} },
    { type:'custom', name:'Beatbox Art Car', mapPct:{left:31.97, top:43.32} },
    { type:'custom', name:'Dreamland ride', mapPct:{left:36.59, top:50.93} },
    { type:'custom', name:'Crazy Dumbo', mapPct:{left:24.46, top:49.27} },
    { type:'water-stations', name:'Water Stations', mapPct:{left:22.64, top:60.93} },
    { type:'custom', name:'Bamboo Village', mapPct:{left:15.26, top:65.07} },
    { type:'custom', name:'Supershot', mapPct:{left:19.75, top:72.24} },
    { type:'custom', name:'Ubuntu', mapPct:{left:13.86, top:72.74} },
    { type:'custom', name:'Nomads Land', mapPct:{left:31.34, top:80.14} },
    { type:'custom', name:'Zipper', mapPct:{left:26.59, top:85.94} },
    { type:'custom', name:'Bloom & Bloom', mapPct:{left:30.19, top:83.8} },
    { type:'stage', name:'bass POD', mapPct:{left:40.85, top:87.74} },
    { type:'custom', name:'Verizon Viewing Deck', mapPct:{left:55.62, top:74.85} },
    { type:'stage', name:'circuit GROUNDS', mapPct:{left:60.51, top:78.38} },
    { type:'stage', name:'waste LAND', mapPct:{left:21.65, top:74.56} },
    { type:'custom', name:'Rave Wave', mapPct:{left:36.5, top:72.89} },
    { type:'custom', name:'Unity', mapPct:{left:61.68, top:63.4} },
    { type:'stage', name:'quantum VALLEY', mapPct:{left:58.82, top:36.71} },
    { type:'stage', name:'kinetic FIELD', mapPct:{left:41.12, top:14.7} },
    { type:'stage', name:'cosmic MEADOW', mapPct:{left:16.8, top:53.9} },
    { type:'custom', name:'Vertigo', mapPct:{left:12.68, top:43.25} },
    { type:'custom', name:'Wave Swinger', mapPct:{left:45.83, top:41.15} },
    { type:'custom', name:'Star fighter', mapPct:{left:49.28, top:36.66} },
    { type:'custom', name:'lunchbox Packs', mapPct:{left:43.57, top:64.41} },
    { type:'custom', name:'END Overdose', mapPct:{left:35.14, top:62.45} },
    { type:'custom', name:'Electrolit', mapPct:{left:38.13, top:64.12} },
    { type:'custom', name:'Flower Towel', mapPct:{left:29.71, top:32.6} },
    { type:'custom', name:'Anima', mapPct:{left:32.52, top:30.72} },
    { type:'custom', name:'Eargasm', mapPct:{left:38.61, top:41.84} },
    { type:'custom', name:'Arcade', mapPct:{left:67.38, top:53.08} },
    { type:'custom', name:'I/O Disco', mapPct:{left:69.47, top:56.33} },
    { type:'custom', name:'Blackout', mapPct:{left:66.58, top:66.88} },
    { type:'custom', name:'Geist', mapPct:{left:57.66, top:64.53} },
    { type:'custom', name:'Savage City', mapPct:{left:20.92, top:85.64} },
    { type:'custom', name:'Chasm', mapPct:{left:25.96, top:79.22} },
    { type:'custom', name:'Momads Portal', mapPct:{left:33.26, top:70.47} },
    { type:'custom', name:'Avengers', mapPct:{left:38.37, top:70.03} },
    { type:'custom', name:'Musik Fest', mapPct:{left:19.93, top:62.89} },
    { type:'kandi-station', name:'Kandi Station', mapPct:{left:62.5, top:38.25} },
    { type:'custom', name:'Glitched bus', mapPct:{left:61.93, top:55.43} },
    { type:'custom', name:'Pixel Forest', mapPct:{left:57.65, top:59.53} },
    { type:'custom', name:'White Claw', mapPct:{left:42.66, top:70.28} },
    { type:'custom', name:'Insomniac Friday', mapPct:{left:34.33, top:33.47} },
    { type:'custom', name:'Daisy Lane Performers', mapPct:{left:40.94, top:38.25} },
    { type:'custom', name:'Daisy Fields', mapPct:{left:28.53, top:27.6} },
    { type:'custom', name:'Casa Bacardi', mapPct:{left:30.34, top:24.85} },
    { type:'custom', name:'VOLTA Anatasia Beverly Hills', mapPct:{left:56.52, top:24.63} },
    { type:'custom', name:'ADA Access Center', mapPct:{left:64.13, top:19.77} },
    { type:'stage', name:'neon GARDEN', mapPct:{left:59.21, top:51.52} },
    { type:'stage', name:'stereo BLOOM', mapPct:{left:33.61, top:39.85} },
    { type:'custom', name:'Sierra Nevada', mapPct:{left:29.35, top:40.79} },
    { type:'custom', name:'Insomniac', mapPct:{left:49.64, top:49.27} },
    { type:'custom', name:'Ghost', mapPct:{left:46.01, top:49.99} },
    { type:'custom', name:'Rainbow Bazaar', mapPct:{left:34.42, top:48.32} },
    { type:'custom', name:'Takis', mapPct:{left:39.41, top:48.78} },
    { type:'custom', name:'Four Loko', mapPct:{left:37.95, top:77.82} },
    { type:'custom', name:'Elder Mother', mapPct:{left:64.49, top:58.54} },
    { type:'custom', name:'Forest House', mapPct:{left:69.29, top:59.7} },
    { type:'custom', name:'Paradisium', mapPct:{left:17.75, top:41.37} },
    { type:'custom', name:'RNBW Lost Angel', mapPct:{left:37.5, top:18.47} },
    { type:'stage', name:'bionic JUNGLE', mapPct:{left:13.68, top:36.15} },
];
