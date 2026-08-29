// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Hot-rolled H/I sections. Dimensions per EN 10365:2017 (Euronorm 53-62 / 19-57), section properties
 * as published in the eurocodeapplied.com "Table of design properties for IPE, HEA, HEB, HEM profiles"
 * (EN 10365 dimensions, EN 1993-1-1 section properties; HEA/HEB/HEM tables obtained through the
 * page's profile-type selector). Every profile was cross-checked against the ArcelorMittal Europe
 * "Sections and Merchant Bars" sales programme (V2023-5): all values agree within 0.1 % except
 * the mass/area rounding (<= 0.6 %) of a few IPE profiles, see worklog/agent-catalogs-report.md.
 * Strong axis = y-y (bending about y), weak axis = z-z.
 * Avz is the shear area for bending about y-y as published by the source; it equals
 * EN 1993-1-1 §6.2.6(3) Avz = A - 2*b*tf + (tw + 2*r)*tf within 1 % for all profiles except IPE80.
 * Units: mm for dimensions, cm² / cm³ / cm⁴ for properties, kg/m for mass.
 * Data files only: no other logic, no external imports.
 */
export const STEEL_H_SECTIONS = [
  { id: 'HEA100', family: 'HEA', h: 96, b: 100, tw: 5, tf: 8, r: 12, A: 21.24, Iy: 349.2, Wely: 72.76, Wply: 83.01, Iz: 133.8, Welz: 26.76, Wplz: 41.14, Avz: 7.56, mass: 16.7, source: 'ea-en10365' },
  { id: 'HEA120', family: 'HEA', h: 114, b: 120, tw: 5, tf: 8, r: 12, A: 25.34, Iy: 606.2, Wely: 106.3, Wply: 119.5, Iz: 230.9, Welz: 38.48, Wplz: 58.85, Avz: 8.46, mass: 19.9, source: 'ea-en10365' },
  { id: 'HEA140', family: 'HEA', h: 133, b: 140, tw: 5.5, tf: 8.5, r: 12, A: 31.42, Iy: 1033, Wely: 155.4, Wply: 173.5, Iz: 389.3, Welz: 55.62, Wplz: 84.85, Avz: 10.12, mass: 24.7, source: 'ea-en10365' },
  { id: 'HEA160', family: 'HEA', h: 152, b: 160, tw: 6, tf: 9, r: 15, A: 38.77, Iy: 1673, Wely: 220.1, Wply: 245.1, Iz: 615.6, Welz: 76.95, Wplz: 117.6, Avz: 13.21, mass: 30.4, source: 'ea-en10365' },
  { id: 'HEA180', family: 'HEA', h: 171, b: 180, tw: 6, tf: 9.5, r: 15, A: 45.25, Iy: 2510, Wely: 293.6, Wply: 324.9, Iz: 924.6, Welz: 102.7, Wplz: 156.5, Avz: 14.47, mass: 35.5, source: 'ea-en10365' },
  { id: 'HEA200', family: 'HEA', h: 190, b: 200, tw: 6.5, tf: 10, r: 18, A: 53.83, Iy: 3692, Wely: 388.6, Wply: 429.5, Iz: 1336, Welz: 133.6, Wplz: 203.8, Avz: 18.08, mass: 42.3, source: 'ea-en10365' },
  { id: 'HEA220', family: 'HEA', h: 210, b: 220, tw: 7, tf: 11, r: 18, A: 64.34, Iy: 5410, Wely: 515.2, Wply: 568.5, Iz: 1955, Welz: 177.7, Wplz: 270.6, Avz: 20.67, mass: 50.5, source: 'ea-en10365' },
  { id: 'HEA240', family: 'HEA', h: 230, b: 240, tw: 7.5, tf: 12, r: 21, A: 76.84, Iy: 7763, Wely: 675.1, Wply: 744.6, Iz: 2769, Welz: 230.7, Wplz: 351.7, Avz: 25.18, mass: 60.3, source: 'ea-en10365' },
  { id: 'HEA260', family: 'HEA', h: 250, b: 260, tw: 7.5, tf: 12.5, r: 24, A: 86.82, Iy: 10450, Wely: 836.4, Wply: 919.8, Iz: 3668, Welz: 282.1, Wplz: 430.2, Avz: 28.76, mass: 68.2, source: 'ea-en10365' },
  { id: 'HEA280', family: 'HEA', h: 270, b: 280, tw: 8, tf: 13, r: 24, A: 97.26, Iy: 13670, Wely: 1013, Wply: 1112, Iz: 4763, Welz: 340.2, Wplz: 518.1, Avz: 31.74, mass: 76.4, source: 'ea-en10365' },
  { id: 'HEA300', family: 'HEA', h: 290, b: 300, tw: 8.5, tf: 14, r: 27, A: 112.53, Iy: 18260, Wely: 1260, Wply: 1383, Iz: 6310, Welz: 420.6, Wplz: 641.2, Avz: 37.28, mass: 88.3, source: 'ea-en10365' },
  { id: 'HEA320', family: 'HEA', h: 310, b: 300, tw: 9, tf: 15.5, r: 27, A: 124.37, Iy: 22930, Wely: 1479, Wply: 1628, Iz: 6985, Welz: 465.7, Wplz: 709.7, Avz: 41.13, mass: 97.6, source: 'ea-en10365' },
  { id: 'HEA340', family: 'HEA', h: 330, b: 300, tw: 9.5, tf: 16.5, r: 27, A: 133.47, Iy: 27690, Wely: 1678, Wply: 1850, Iz: 7436, Welz: 495.7, Wplz: 755.9, Avz: 44.95, mass: 104.8, source: 'ea-en10365' },
  { id: 'HEA360', family: 'HEA', h: 350, b: 300, tw: 10, tf: 17.5, r: 27, A: 142.76, Iy: 33090, Wely: 1891, Wply: 2088, Iz: 7887, Welz: 525.8, Wplz: 802.3, Avz: 48.96, mass: 112.1, source: 'ea-en10365' },
  { id: 'HEA400', family: 'HEA', h: 390, b: 300, tw: 11, tf: 19, r: 27, A: 158.98, Iy: 45070, Wely: 2311, Wply: 2562, Iz: 8564, Welz: 570.9, Wplz: 872.9, Avz: 57.33, mass: 124.8, source: 'ea-en10365' },
  { id: 'HEA450', family: 'HEA', h: 440, b: 300, tw: 11.5, tf: 21, r: 27, A: 178.03, Iy: 63720, Wely: 2896, Wply: 3216, Iz: 9465, Welz: 631, Wplz: 965.5, Avz: 65.78, mass: 139.8, source: 'ea-en10365' },
  { id: 'HEA500', family: 'HEA', h: 490, b: 300, tw: 12, tf: 23, r: 27, A: 197.54, Iy: 86970, Wely: 3550, Wply: 3949, Iz: 10370, Welz: 691.1, Wplz: 1059, Avz: 74.72, mass: 155.1, source: 'ea-en10365' },
  { id: 'HEA550', family: 'HEA', h: 540, b: 300, tw: 12.5, tf: 24, r: 27, A: 211.76, Iy: 111900, Wely: 4146, Wply: 4622, Iz: 10820, Welz: 721.3, Wplz: 1107, Avz: 83.72, mass: 166.2, source: 'ea-en10365' },
  { id: 'HEA600', family: 'HEA', h: 590, b: 300, tw: 13, tf: 25, r: 27, A: 226.46, Iy: 141200, Wely: 4787, Wply: 5350, Iz: 11270, Welz: 751.4, Wplz: 1156, Avz: 93.21, mass: 177.8, source: 'ea-en10365' },
  { id: 'HEA650', family: 'HEA', h: 640, b: 300, tw: 13.5, tf: 26, r: 27, A: 241.64, Iy: 175200, Wely: 5474, Wply: 6136, Iz: 11720, Welz: 781.6, Wplz: 1205, Avz: 103.19, mass: 189.7, source: 'ea-en10365' },
  { id: 'HEA700', family: 'HEA', h: 690, b: 300, tw: 14.5, tf: 27, r: 27, A: 260.48, Iy: 215300, Wely: 6241, Wply: 7032, Iz: 12180, Welz: 811.9, Wplz: 1257, Avz: 116.97, mass: 204.5, source: 'ea-en10365' },
  { id: 'HEA800', family: 'HEA', h: 790, b: 300, tw: 15, tf: 28, r: 30, A: 285.83, Iy: 303400, Wely: 7682, Wply: 8699, Iz: 12640, Welz: 842.6, Wplz: 1312, Avz: 138.83, mass: 224.4, source: 'ea-en10365' },
  { id: 'HEA900', family: 'HEA', h: 890, b: 300, tw: 16, tf: 30, r: 30, A: 320.53, Iy: 422100, Wely: 9485, Wply: 10810, Iz: 13550, Welz: 903.2, Wplz: 1414, Avz: 163.33, mass: 251.6, source: 'ea-en10365' },
  { id: 'HEA1000', family: 'HEA', h: 990, b: 300, tw: 16.5, tf: 31, r: 30, A: 346.85, Iy: 553800, Wely: 11190, Wply: 12820, Iz: 14000, Welz: 933.6, Wplz: 1470, Avz: 184.56, mass: 272.3, source: 'ea-en10365' },
  { id: 'HEB100', family: 'HEB', h: 100, b: 100, tw: 6, tf: 10, r: 12, A: 26.04, Iy: 449.5, Wely: 89.91, Wply: 104.2, Iz: 167.3, Welz: 33.45, Wplz: 51.42, Avz: 9.04, mass: 20.4, source: 'ea-en10365' },
  { id: 'HEB120', family: 'HEB', h: 120, b: 120, tw: 6.5, tf: 11, r: 12, A: 34.01, Iy: 864.4, Wely: 144.1, Wply: 165.2, Iz: 317.5, Welz: 52.92, Wplz: 80.97, Avz: 10.96, mass: 26.7, source: 'ea-en10365' },
  { id: 'HEB140', family: 'HEB', h: 140, b: 140, tw: 7, tf: 12, r: 12, A: 42.96, Iy: 1509, Wely: 215.6, Wply: 245.4, Iz: 549.7, Welz: 78.52, Wplz: 119.8, Avz: 13.08, mass: 33.7, source: 'ea-en10365' },
  { id: 'HEB160', family: 'HEB', h: 160, b: 160, tw: 8, tf: 13, r: 15, A: 54.25, Iy: 2492, Wely: 311.5, Wply: 354, Iz: 889.2, Welz: 111.2, Wplz: 170, Avz: 17.59, mass: 42.6, source: 'ea-en10365' },
  { id: 'HEB180', family: 'HEB', h: 180, b: 180, tw: 8.5, tf: 14, r: 15, A: 65.25, Iy: 3831, Wely: 425.7, Wply: 481.4, Iz: 1363, Welz: 151.4, Wplz: 231, Avz: 20.24, mass: 51.2, source: 'ea-en10365' },
  { id: 'HEB200', family: 'HEB', h: 200, b: 200, tw: 9, tf: 15, r: 18, A: 78.08, Iy: 5696, Wely: 569.6, Wply: 642.5, Iz: 2003, Welz: 200.3, Wplz: 305.8, Avz: 24.83, mass: 61.3, source: 'ea-en10365' },
  { id: 'HEB220', family: 'HEB', h: 220, b: 220, tw: 9.5, tf: 16, r: 18, A: 91.04, Iy: 8091, Wely: 735.5, Wply: 827, Iz: 2843, Welz: 258.5, Wplz: 393.9, Avz: 27.92, mass: 71.5, source: 'ea-en10365' },
  { id: 'HEB240', family: 'HEB', h: 240, b: 240, tw: 10, tf: 17, r: 21, A: 105.99, Iy: 11260, Wely: 938.3, Wply: 1053, Iz: 3923, Welz: 326.9, Wplz: 498.4, Avz: 33.23, mass: 83.2, source: 'ea-en10365' },
  { id: 'HEB260', family: 'HEB', h: 260, b: 260, tw: 10, tf: 17.5, r: 24, A: 118.44, Iy: 14920, Wely: 1148, Wply: 1283, Iz: 5135, Welz: 395, Wplz: 602.2, Avz: 37.59, mass: 93, source: 'ea-en10365' },
  { id: 'HEB280', family: 'HEB', h: 280, b: 280, tw: 10.5, tf: 18, r: 24, A: 131.36, Iy: 19270, Wely: 1376, Wply: 1534, Iz: 6595, Welz: 471, Wplz: 717.6, Avz: 41.09, mass: 103.1, source: 'ea-en10365' },
  { id: 'HEB300', family: 'HEB', h: 300, b: 300, tw: 11, tf: 19, r: 27, A: 149.08, Iy: 25170, Wely: 1678, Wply: 1869, Iz: 8563, Welz: 570.9, Wplz: 870.1, Avz: 47.43, mass: 117, source: 'ea-en10365' },
  { id: 'HEB320', family: 'HEB', h: 320, b: 300, tw: 11.5, tf: 20.5, r: 27, A: 161.34, Iy: 30820, Wely: 1926, Wply: 2149, Iz: 9239, Welz: 615.9, Wplz: 939.1, Avz: 51.77, mass: 126.7, source: 'ea-en10365' },
  { id: 'HEB340', family: 'HEB', h: 340, b: 300, tw: 12, tf: 21.5, r: 27, A: 170.9, Iy: 36660, Wely: 2156, Wply: 2408, Iz: 9690, Welz: 646, Wplz: 985.7, Avz: 56.09, mass: 134.2, source: 'ea-en10365' },
  { id: 'HEB360', family: 'HEB', h: 360, b: 300, tw: 12.5, tf: 22.5, r: 27, A: 180.63, Iy: 43190, Wely: 2400, Wply: 2683, Iz: 10140, Welz: 676.1, Wplz: 1032, Avz: 60.6, mass: 141.8, source: 'ea-en10365' },
  { id: 'HEB400', family: 'HEB', h: 400, b: 300, tw: 13.5, tf: 24, r: 27, A: 197.78, Iy: 57680, Wely: 2884, Wply: 3232, Iz: 10820, Welz: 721.3, Wplz: 1104, Avz: 69.98, mass: 155.3, source: 'ea-en10365' },
  { id: 'HEB450', family: 'HEB', h: 450, b: 300, tw: 14, tf: 26, r: 27, A: 217.98, Iy: 79890, Wely: 3551, Wply: 3982, Iz: 11720, Welz: 781.4, Wplz: 1198, Avz: 79.66, mass: 171.1, source: 'ea-en10365' },
  { id: 'HEB500', family: 'HEB', h: 500, b: 300, tw: 14.5, tf: 28, r: 27, A: 238.64, Iy: 107200, Wely: 4287, Wply: 4815, Iz: 12620, Welz: 841.6, Wplz: 1292, Avz: 89.82, mass: 187.3, source: 'ea-en10365' },
  { id: 'HEB550', family: 'HEB', h: 550, b: 300, tw: 15, tf: 29, r: 27, A: 254.06, Iy: 136700, Wely: 4971, Wply: 5591, Iz: 13080, Welz: 871.8, Wplz: 1341, Avz: 100.07, mass: 199.4, source: 'ea-en10365' },
  { id: 'HEB600', family: 'HEB', h: 600, b: 300, tw: 15.5, tf: 30, r: 27, A: 269.96, Iy: 171000, Wely: 5701, Wply: 6425, Iz: 13530, Welz: 902, Wplz: 1391, Avz: 110.81, mass: 211.9, source: 'ea-en10365' },
  { id: 'HEB650', family: 'HEB', h: 650, b: 300, tw: 16, tf: 31, r: 27, A: 286.34, Iy: 210600, Wely: 6480, Wply: 7320, Iz: 13980, Welz: 932.3, Wplz: 1441, Avz: 122.04, mass: 224.8, source: 'ea-en10365' },
  { id: 'HEB700', family: 'HEB', h: 700, b: 300, tw: 17, tf: 32, r: 27, A: 306.38, Iy: 256900, Wely: 7340, Wply: 8327, Iz: 14440, Welz: 962.7, Wplz: 1495, Avz: 137.1, mass: 240.5, source: 'ea-en10365' },
  { id: 'HEB800', family: 'HEB', h: 800, b: 300, tw: 17.5, tf: 33, r: 30, A: 334.18, Iy: 359100, Wely: 8977, Wply: 10230, Iz: 14900, Welz: 993.6, Wplz: 1553, Avz: 161.75, mass: 262.3, source: 'ea-en10365' },
  { id: 'HEB900', family: 'HEB', h: 900, b: 300, tw: 18.5, tf: 35, r: 30, A: 371.28, Iy: 494100, Wely: 10980, Wply: 12580, Iz: 15820, Welz: 1054, Wplz: 1658, Avz: 188.75, mass: 291.5, source: 'ea-en10365' },
  { id: 'HEB1000', family: 'HEB', h: 1000, b: 300, tw: 19, tf: 36, r: 30, A: 400.05, Iy: 644700, Wely: 12890, Wply: 14860, Iz: 16280, Welz: 1085, Wplz: 1716, Avz: 212.49, mass: 314, source: 'ea-en10365' },
  { id: 'HEM100', family: 'HEM', h: 120, b: 106, tw: 12, tf: 20, r: 12, A: 53.24, Iy: 1143, Wely: 190.4, Wply: 235.8, Iz: 399.2, Welz: 75.31, Wplz: 116.3, Avz: 18.04, mass: 41.8, source: 'ea-en10365' },
  { id: 'HEM120', family: 'HEM', h: 140, b: 126, tw: 12.5, tf: 21, r: 12, A: 66.41, Iy: 2018, Wely: 288.2, Wply: 350.6, Iz: 702.8, Welz: 111.6, Wplz: 171.6, Avz: 21.15, mass: 52.1, source: 'ea-en10365' },
  { id: 'HEM140', family: 'HEM', h: 160, b: 146, tw: 13, tf: 22, r: 12, A: 80.56, Iy: 3291, Wely: 411.4, Wply: 493.8, Iz: 1144, Welz: 156.8, Wplz: 240.5, Avz: 24.46, mass: 63.2, source: 'ea-en10365' },
  { id: 'HEM160', family: 'HEM', h: 180, b: 166, tw: 14, tf: 23, r: 15, A: 97.05, Iy: 5098, Wely: 566.5, Wply: 674.6, Iz: 1759, Welz: 211.9, Wplz: 325.5, Avz: 30.81, mass: 76.2, source: 'ea-en10365' },
  { id: 'HEM180', family: 'HEM', h: 200, b: 186, tw: 14.5, tf: 24, r: 15, A: 113.25, Iy: 7483, Wely: 748.3, Wply: 883.4, Iz: 2580, Welz: 277.4, Wplz: 425.2, Avz: 34.65, mass: 88.9, source: 'ea-en10365' },
  { id: 'HEM200', family: 'HEM', h: 220, b: 206, tw: 15, tf: 25, r: 18, A: 131.28, Iy: 10640, Wely: 967.4, Wply: 1135, Iz: 3651, Welz: 354.5, Wplz: 543.2, Avz: 41.03, mass: 103.1, source: 'ea-en10365' },
  { id: 'HEM220', family: 'HEM', h: 240, b: 226, tw: 15.5, tf: 26, r: 18, A: 149.44, Iy: 14600, Wely: 1217, Wply: 1419, Iz: 5012, Welz: 443.5, Wplz: 678.6, Avz: 45.31, mass: 117.3, source: 'ea-en10365' },
  { id: 'HEM240', family: 'HEM', h: 270, b: 248, tw: 18, tf: 32, r: 21, A: 199.59, Iy: 24290, Wely: 1799, Wply: 2117, Iz: 8153, Welz: 657.5, Wplz: 1006, Avz: 60.07, mass: 156.7, source: 'ea-en10365' },
  { id: 'HEM260', family: 'HEM', h: 290, b: 268, tw: 18, tf: 32.5, r: 24, A: 219.64, Iy: 31310, Wely: 2159, Wply: 2524, Iz: 10450, Welz: 779.7, Wplz: 1192, Avz: 66.89, mass: 172.4, source: 'ea-en10365' },
  { id: 'HEM280', family: 'HEM', h: 310, b: 288, tw: 18.5, tf: 33, r: 24, A: 240.16, Iy: 39550, Wely: 2551, Wply: 2966, Iz: 13160, Welz: 914.1, Wplz: 1397, Avz: 72.03, mass: 188.5, source: 'ea-en10365' },
  { id: 'HEM300', family: 'HEM', h: 340, b: 310, tw: 21, tf: 39, r: 27, A: 303.08, Iy: 59200, Wely: 3482, Wply: 4078, Iz: 19400, Welz: 1252, Wplz: 1913, Avz: 90.53, mass: 237.9, source: 'ea-en10365' },
  { id: 'HEM320', family: 'HEM', h: 359, b: 309, tw: 21, tf: 40, r: 27, A: 312.05, Iy: 68130, Wely: 3796, Wply: 4435, Iz: 19710, Welz: 1276, Wplz: 1951, Avz: 94.85, mass: 245, source: 'ea-en10365' },
  { id: 'HEM340', family: 'HEM', h: 377, b: 309, tw: 21, tf: 40, r: 27, A: 315.83, Iy: 76370, Wely: 4052, Wply: 4718, Iz: 19710, Welz: 1276, Wplz: 1953, Avz: 98.63, mass: 247.9, source: 'ea-en10365' },
  { id: 'HEM360', family: 'HEM', h: 395, b: 308, tw: 21, tf: 40, r: 27, A: 318.81, Iy: 84870, Wely: 4297, Wply: 4989, Iz: 19520, Welz: 1268, Wplz: 1942, Avz: 102.41, mass: 250.3, source: 'ea-en10365' },
  { id: 'HEM400', family: 'HEM', h: 432, b: 307, tw: 21, tf: 40, r: 27, A: 325.78, Iy: 104100, Wely: 4820, Wply: 5571, Iz: 19340, Welz: 1260, Wplz: 1934, Avz: 110.18, mass: 255.7, source: 'ea-en10365' },
  { id: 'HEM450', family: 'HEM', h: 478, b: 307, tw: 21, tf: 40, r: 27, A: 335.44, Iy: 131500, Wely: 5501, Wply: 6331, Iz: 19340, Welz: 1260, Wplz: 1939, Avz: 119.84, mass: 263.3, source: 'ea-en10365' },
  { id: 'HEM500', family: 'HEM', h: 524, b: 306, tw: 21, tf: 40, r: 27, A: 344.3, Iy: 161900, Wely: 6180, Wply: 7094, Iz: 19150, Welz: 1252, Wplz: 1932, Avz: 129.5, mass: 270.3, source: 'ea-en10365' },
  { id: 'HEM550', family: 'HEM', h: 572, b: 306, tw: 21, tf: 40, r: 27, A: 354.38, Iy: 198000, Wely: 6923, Wply: 7933, Iz: 19160, Welz: 1252, Wplz: 1937, Avz: 139.58, mass: 278.2, source: 'ea-en10365' },
  { id: 'HEM600', family: 'HEM', h: 620, b: 305, tw: 21, tf: 40, r: 27, A: 363.66, Iy: 237400, Wely: 7660, Wply: 8772, Iz: 18980, Welz: 1244, Wplz: 1930, Avz: 149.66, mass: 285.5, source: 'ea-en10365' },
  { id: 'HEM650', family: 'HEM', h: 668, b: 305, tw: 21, tf: 40, r: 27, A: 373.74, Iy: 281700, Wely: 8433, Wply: 9657, Iz: 18980, Welz: 1245, Wplz: 1936, Avz: 159.74, mass: 293.4, source: 'ea-en10365' },
  { id: 'HEM700', family: 'HEM', h: 716, b: 304, tw: 21, tf: 40, r: 27, A: 383.02, Iy: 329300, Wely: 9198, Wply: 10540, Iz: 18800, Welz: 1237, Wplz: 1929, Avz: 169.82, mass: 300.7, source: 'ea-en10365' },
  { id: 'HEM800', family: 'HEM', h: 814, b: 303, tw: 21, tf: 40, r: 30, A: 404.27, Iy: 442600, Wely: 10870, Wply: 12490, Iz: 18630, Welz: 1230, Wplz: 1930, Avz: 194.27, mass: 317.3, source: 'ea-en10365' },
  { id: 'HEM900', family: 'HEM', h: 910, b: 302, tw: 21, tf: 40, r: 30, A: 423.63, Iy: 570400, Wely: 12540, Wply: 14440, Iz: 18450, Welz: 1222, Wplz: 1929, Avz: 214.43, mass: 332.5, source: 'ea-en10365' },
  { id: 'HEM1000', family: 'HEM', h: 1008, b: 302, tw: 21, tf: 40, r: 30, A: 444.21, Iy: 722300, Wely: 14330, Wply: 16570, Iz: 18460, Welz: 1222, Wplz: 1940, Avz: 235.01, mass: 348.7, source: 'ea-en10365' },
  { id: 'IPE80', family: 'IPE', h: 80, b: 46, tw: 3.8, tf: 5.2, r: 5, A: 7.64, Iy: 80.14, Wely: 20.03, Wply: 23.22, Iz: 8.489, Welz: 3.691, Wplz: 5.818, Avz: 3.58, mass: 6, source: 'ea-en10365' },
  { id: 'IPE100', family: 'IPE', h: 100, b: 55, tw: 4.1, tf: 5.7, r: 7, A: 10.32, Iy: 171, Wely: 34.2, Wply: 39.41, Iz: 15.92, Welz: 5.789, Wplz: 9.146, Avz: 5.08, mass: 8.1, source: 'ea-en10365' },
  { id: 'IPE120', family: 'IPE', h: 120, b: 64, tw: 4.4, tf: 6.3, r: 7, A: 13.21, Iy: 317.8, Wely: 52.96, Wply: 60.73, Iz: 27.67, Welz: 8.646, Wplz: 13.58, Avz: 6.31, mass: 10.4, source: 'ea-en10365' },
  { id: 'IPE140', family: 'IPE', h: 140, b: 73, tw: 4.7, tf: 6.9, r: 7, A: 16.43, Iy: 541.2, Wely: 77.32, Wply: 88.34, Iz: 44.92, Welz: 12.31, Wplz: 19.25, Avz: 7.64, mass: 12.9, source: 'ea-en10365' },
  { id: 'IPE160', family: 'IPE', h: 160, b: 82, tw: 5, tf: 7.4, r: 9, A: 20.09, Iy: 869.3, Wely: 108.7, Wply: 123.9, Iz: 68.31, Welz: 16.66, Wplz: 26.1, Avz: 9.66, mass: 15.8, source: 'ea-en10365' },
  { id: 'IPE180', family: 'IPE', h: 180, b: 91, tw: 5.3, tf: 8, r: 9, A: 23.95, Iy: 1317, Wely: 146.3, Wply: 166.4, Iz: 100.9, Welz: 22.16, Wplz: 34.6, Avz: 11.25, mass: 18.8, source: 'ea-en10365' },
  { id: 'IPE200', family: 'IPE', h: 200, b: 100, tw: 5.6, tf: 8.5, r: 12, A: 28.48, Iy: 1943, Wely: 194.3, Wply: 220.6, Iz: 142.4, Welz: 28.47, Wplz: 44.61, Avz: 14, mass: 22.4, source: 'ea-en10365' },
  { id: 'IPE220', family: 'IPE', h: 220, b: 110, tw: 5.9, tf: 9.2, r: 12, A: 33.37, Iy: 2772, Wely: 252, Wply: 285.4, Iz: 204.9, Welz: 37.25, Wplz: 58.11, Avz: 15.88, mass: 26.2, source: 'ea-en10365' },
  { id: 'IPE240', family: 'IPE', h: 240, b: 120, tw: 6.2, tf: 9.8, r: 15, A: 39.12, Iy: 3892, Wely: 324.3, Wply: 366.6, Iz: 283.6, Welz: 47.27, Wplz: 73.92, Avz: 19.14, mass: 30.7, source: 'ea-en10365' },
  { id: 'IPE270', family: 'IPE', h: 270, b: 135, tw: 6.6, tf: 10.2, r: 15, A: 45.95, Iy: 5790, Wely: 428.9, Wply: 484, Iz: 419.9, Welz: 62.2, Wplz: 96.95, Avz: 22.14, mass: 36.1, source: 'ea-en10365' },
  { id: 'IPE300', family: 'IPE', h: 300, b: 150, tw: 7.1, tf: 10.7, r: 15, A: 53.81, Iy: 8356, Wely: 557.1, Wply: 628.4, Iz: 603.8, Welz: 80.5, Wplz: 125.2, Avz: 25.68, mass: 42.2, source: 'ea-en10365' },
  { id: 'IPE330', family: 'IPE', h: 330, b: 160, tw: 7.5, tf: 11.5, r: 18, A: 62.61, Iy: 11770, Wely: 713.1, Wply: 804.3, Iz: 788.1, Welz: 98.52, Wplz: 153.7, Avz: 30.81, mass: 49.1, source: 'ea-en10365' },
  { id: 'IPE360', family: 'IPE', h: 360, b: 170, tw: 8, tf: 12.7, r: 18, A: 72.73, Iy: 16270, Wely: 903.6, Wply: 1019, Iz: 1043, Welz: 122.8, Wplz: 191.1, Avz: 35.14, mass: 57.1, source: 'ea-en10365' },
  { id: 'IPE400', family: 'IPE', h: 400, b: 180, tw: 8.6, tf: 13.5, r: 21, A: 84.46, Iy: 23130, Wely: 1156, Wply: 1307, Iz: 1318, Welz: 146.4, Wplz: 229, Avz: 42.69, mass: 66.3, source: 'ea-en10365' },
  { id: 'IPE450', family: 'IPE', h: 450, b: 190, tw: 9.4, tf: 14.6, r: 21, A: 98.82, Iy: 33740, Wely: 1500, Wply: 1702, Iz: 1676, Welz: 176.4, Wplz: 276.4, Avz: 50.85, mass: 77.6, source: 'ea-en10365' },
  { id: 'IPE500', family: 'IPE', h: 500, b: 200, tw: 10.2, tf: 16, r: 21, A: 115.52, Iy: 48200, Wely: 1928, Wply: 2194, Iz: 2142, Welz: 214.2, Wplz: 335.9, Avz: 59.87, mass: 90.7, source: 'ea-en10365' },
  { id: 'IPE550', family: 'IPE', h: 550, b: 210, tw: 11.1, tf: 17.2, r: 24, A: 134.42, Iy: 67120, Wely: 2441, Wply: 2787, Iz: 2668, Welz: 254.1, Wplz: 400.5, Avz: 72.34, mass: 105.5, source: 'ea-en10365' },
  { id: 'IPE600', family: 'IPE', h: 600, b: 220, tw: 12, tf: 19, r: 24, A: 155.98, Iy: 92080, Wely: 3069, Wply: 3512, Iz: 3387, Welz: 307.9, Wplz: 485.6, Avz: 83.78, mass: 122.4, source: 'ea-en10365' },
];

export const STEEL_H_SOURCES = {
  'ea-en10365': {
    title: 'Table of design properties for IPE, HEA, HEB, HEM profiles (Eurocode 3, dimensions per EN 10365)',
    publisher: 'eurocodeapplied.com',
    url: 'https://eurocodeapplied.com/design/en1993/ipe-hea-heb-hem-design-properties',
    accessed: '2026-08-29',
    note: 'IPE table served on the page; HEA/HEB/HEM via the Calculation.ProfileType selector (1, 2, 3). Source units mm², ×10⁶ mm⁴, ×10³ mm³ converted to cm², cm⁴, cm³.',
  },
  'am-sections-2023': {
    title: 'ArcelorMittal Europe – Sections and Merchant Bars, Sales programme (edition V2023-5), cross-check only',
    publisher: 'ArcelorMittal Europe – Long Products',
    url: 'https://sections.arcelormittal.com/repository2/Sections/Sections_MB_ArcelorMittal_FR_EN_DE_V2023-5.pdf',
    accessed: '2026-08-29',
  },
};

/**
 * Case/space-insensitive lookup. Accepts 'HEA180', 'hea 180', 'HE 180 A', 'HE180A', 'IPE 400'.
 * @param {string} id
 * @returns {object|null}
 */
export function findHSection(id) {
  if (typeof id !== 'string') return null;
  let key = id.toUpperCase().replace(/[\s.\-_]/g, '');
  const m = /^HE(\d+)(A|B|M)$/.exec(key);
  if (m) key = `HE${m[2]}${m[1]}`;
  for (const s of STEEL_H_SECTIONS) if (s.id === key) return s;
  return null;
}
