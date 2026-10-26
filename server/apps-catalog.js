// Bekannte Tizen-App-IDs. Viele TVs ab 2020 beantworten die App-Listen-Abfrage nicht mehr,
// daher wird jede ID einzeln per REST geprüft; nicht installierte Apps liefern 404.
// Eigene IDs lassen sich in config.json unter "extraApps" ergänzen.
export const APP_CATALOG = [
  '3201907018807', '11101200001',            // Netflix
  '111299001912',                            // YouTube
  '3201910019365', '3201512006785',          // Prime Video
  '3201901017640',                           // Disney+
  '3201807016597',                           // Apple TV
  '3201606009684',                           // Spotify
  '3201512006963',                           // Plex
  '3201511006428',                           // Rakuten TV
  '3201710015037',                           // Gallery
  '3202010022079', 'org.tizen.browser',      // Browser
  '3201908019041',                           // Apple Music
  '3201806016390',                           // DAZN
  '3201707014361',                           // RTL+
  '3201905018355',                           // Joyn
  '3201802015748',                           // waipu.tv
  '3201607010031',                           // Zattoo
  '3202001020060',                           // MagentaTV
  '3201710014874',                           // Paramount+
  '3201512006837',                           // ARTE
  '3202203026841',                           // Xbox
  '3201702011851',                           // Steam Link
];
