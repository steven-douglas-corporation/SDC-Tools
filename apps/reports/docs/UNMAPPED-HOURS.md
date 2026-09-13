# Hours that never reach a project figure

Generated from the Power BI `Hours Actual` table (`Data Source = "Paylocity Hours"`), covering **2025-02 – 2026-07**. Every hour below is real booked time that does **not** appear against a job on the Projects grid.

| bucket | hours | codes | why |
|---|---:|---:|---|
| A. Lost entirely | **5,981.8** | 31 | no ETC column and no Standard Fees pool |
| B. Pool-only | 6,224.8 | 7 | counted company-wide in a pool, never per job |
| C. Job Id `NOT DEFINED` | 6,861 | 35 | no job on the punch, upstream in Paylocity |
| **Total** | **19,067.6** | | |

The app models 17 `MachineSec-Function` codes (see `SECTIONS` in `src/lib/sections.ts`). Every other code is folded onto one of them using the model's OWN `Function Hierarchy` table, which files each code under a (Section Name, Section Function Name) pair. Anything outside that set has nowhere to go.

## A. Lost entirely

These reach no figure anywhere in the app — not the Projects grid, not the Monthly ETC grid, not the Standard Fees pools. Chiefly the `Service` phase (80-*) and 90-*, which the app has no phase for at all, plus `10-400` and the codes Power BI itself marks Invalid.

| code | hours | projects |
|---|---:|---:|
| `80-311` | 1,666.9 | 61 |
| `10-400` | 833 | 4 |
| `80-411` | 828.4 | 17 |
| `80-211` | 708.5 | 34 |
| `80-412` | 577.8 | 27 |
| `90-414` | 217.1 | 13 |
| `70-414` | 202.9 | 6 |
| `10-118` | 135.3 | 2 |
| `90-211` | 124.7 | 26 |
| `1-312` | 116.5 | 7 |
| `90-411` | 78.2 | 6 |
| `80-414` | 77.9 | 12 |
| `70-516` | 77.8 | 4 |
| `5-111` | 71 | 7 |
| `1-311` | 44.5 | 4 |
| `80-313` | 34.8 | 3 |
| `80-516` | 33.5 | 4 |
| `80-312` | 28.3 | 3 |
| `70-413` | 25 | 2 |
| `10-112` | 22.5 | 4 |
| `Not Defined-311` | 18.3 | 3 |
| `10-119` | 12.1 | 2 |
| `1-100` | 8 | 1 |
| `90-412` | 7.8 | 1 |
| `Not Defined-Not Defined` | 6.4 | 2 |
| `70-517` | 6.1 | 1 |
| `12-311` | 5 | 1 |
| `Not Defined-211` | 4.7 | 3 |
| `1-118` | 4 | 1 |
| `90-311` | 4 | 3 |
| `80-112` | 0.7 | 1 |

### `80-311` — 1,666.9h across 61 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 925 | 263.7 | **not in the app** | — |
| 861 | 184.3 | Complete | Automated Packaging Machine |
| 1052 | 95 | Complete | Three ZIP Seaming Systems |
| 995 | 86 | Complete | AutoTape and QDTape Assembly Machines |
| 911 | 71.8 | **not in the app** | — |
| 1120 | 71.8 | Complete | Bleep Sleep Assembly Machine Upgrades |
| 996 | 60.3 | Complete | GM Assembly Machine |
| 4263 | 56 | **not in the app** | — |
| 1066 | 44 | Complete | Mar-Bal Press Loader |
| 1067 | 43 | Complete | Baseline Assembly Cell |
| 735 | 40.5 | **not in the app** | — |
| 859 | 40.5 | Complete | FK0555 Novi Coil Assy |
| 878 | 38.5 | Complete | XY Mapper |
| 803 | 36.5 | **not in the app** | — |
| 1058 | 32.3 | Complete | Instant Ink Fulfillment Automation |
| 927 | 30.8 | Complete | Main Coil Assembly |
| 953 | 28.5 | Complete | Hail Impact Machine |
| 6000 | 28.3 | Active | Bellco Feeders |
| 1041 | 25.5 | Complete | 30K Disassembly Tool |
| 964 | 23.5 | **not in the app** | — |
| 988 | 23 | Complete | Mosquito Repellent Refill Packaging Machine |
| 854 | 22.5 | Complete | Flat Sheet Sander Automation |
| 1024 | 22 | Complete | Vertebrae Assembly |
| 934 | 21 | **not in the app** | — |
| 624 | 20.5 | **not in the app** | — |
| 928 | 19.5 | Complete | Final Assembly & Testing |
| 1080 | 17 | Complete | Manually Loaded Box Closer |
| 1013 | 16.5 | Complete | Paragon Manufacturing Cell QTY 2 |
| 1072 | 15 | Complete | Duplicate 60L Seamer Conversion QTY (2) |
| 1070 | 14.3 | Complete | Replicated Auto Bubbler |
| 1029 | 14 | Complete | Next Generation Casting Machine QTY(3) |
| 1031 | 13.5 | Complete | Press 10 Revitalization |
| 867 | 13 | Complete | Permasert 2.0 Automation |
| 923 | 13 | **not in the app** | — |
| 1057 | 11.8 | Complete | EP10 Auto Stent QTY (2) |
| 1089 | 11.5 | Complete | ShurTape Auto Boxing Line |
| 993 | 11 | Complete | Winding Unload System X2 |
| 1034 | 9 | Complete | Poet-CV |
| 1105 | 8 | Active | Clip-iT Retrofit |
| 955 | 8 | Complete | Duplicate SDC VMW Machine |
| 1037 | 6.5 | Complete | 60L Seamer Conversion |
| 1086 | 6 | Complete | Laser Cable Cutter Cell |
| 36 | 6 | **not in the app** | — |
| 907 | 5.5 | **not in the app** | — |
| 915 | 5.3 | **not in the app** | — |
| 114 | 4 | **not in the app** | — |
| 1012 | 3.3 | Complete | Edwards Ireland_EP10 QTY(2) |
| 966 | 3 | Complete | Benctop Paper Lid Closing Machine |
| 982 | 3 | Complete | EP10 Auto Stent Electropolishing Machine |
| 1077 | 2.8 | Complete | Miscellaneous Seamer Improvements and Upgrades |
| 4000 | 2.5 | Active | Non-Billable |
| 1111 | 2.5 | Complete | Duplicate Refill Machine |
| 961 | 2 | Complete | Duplicate Inline Air Tester |
| 1116 | 2 | Complete | Flexible Brazing Machine |
| 1074 | 2 | Complete | Automated Packaging Machine |
| 962 | 1.5 | Complete | Machine Build Phase 3 & Eng |
| 990 | 1.5 | Complete | InShot No.2 |
| 1054 | 1.3 | Complete | ADAC3 – WIT |
| 989 | 1 | Complete | Mat Dosing Machine |
| 1020 | 0.5 | Complete | S7 Wet Hi-Pot |
| 1079 | 0.5 | Complete | Duplicate Paragon Assembly Cell QTY (2) |

### `10-400` — 833h across 4 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 4000 | 829.7 | Active | Non-Billable |
| 1104 | 2.9 | Active | Andi 1 & Andi 2 Replacement Line |
| 1116 | 0.3 | Complete | Flexible Brazing Machine |
| 1083 | 0.1 | Active | SDC Showroom |

### `80-411` — 828.4h across 17 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1105 | 265.2 | Active | Clip-iT Retrofit |
| 2025 | 250.5 | Active | 2025 Spare Parts |
| 1120 | 88.8 | Complete | Bleep Sleep Assembly Machine Upgrades |
| 1029 | 39.4 | Complete | Next Generation Casting Machine QTY(3) |
| 735 | 32.2 | **not in the app** | — |
| 1116 | 31.9 | Complete | Flexible Brazing Machine |
| 923 | 21.3 | **not in the app** | — |
| 1058 | 21.2 | Complete | Instant Ink Fulfillment Automation |
| 996 | 13.5 | Complete | GM Assembly Machine |
| 1096 | 11 | Complete | SDC High Temp Light Soak Chamber |
| 1070 | 10.7 | Complete | Replicated Auto Bubbler |
| 1107 | 10.7 | Complete | Spiral Trap Assy |
| 911 | 10.5 | **not in the app** | — |
| 1020 | 9 | Complete | S7 Wet Hi-Pot |
| 934 | 7 | **not in the app** | — |
| 1024 | 3.1 | Complete | Vertebrae Assembly |
| 995 | 2.2 | Complete | AutoTape and QDTape Assembly Machines |

### `80-211` — 708.5h across 34 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1116 | 108.2 | Complete | Flexible Brazing Machine |
| 1024 | 69.1 | Complete | Vertebrae Assembly |
| 1120 | 63.5 | Complete | Bleep Sleep Assembly Machine Upgrades |
| 1089 | 45.3 | Complete | ShurTape Auto Boxing Line |
| 996 | 43 | Complete | GM Assembly Machine |
| 735 | 40 | **not in the app** | — |
| 988 | 35 | Complete | Mosquito Repellent Refill Packaging Machine |
| 1058 | 35 | Complete | Instant Ink Fulfillment Automation |
| 1067 | 28.8 | Complete | Baseline Assembly Cell |
| 2025 | 26.5 | Active | 2025 Spare Parts |
| 927 | 21.2 | Complete | Main Coil Assembly |
| 1106 | 20.1 | Active | SDC Clip-iT 1.1 QTY (8) |
| 923 | 19.3 | **not in the app** | — |
| 1070 | 17.7 | Complete | Replicated Auto Bubbler |
| 854 | 15.5 | Complete | Flat Sheet Sander Automation |
| 1030 | 15.4 | Complete | 10 Pack Boxing Machine |
| 861 | 15.2 | Complete | Automated Packaging Machine |
| 928 | 12 | Complete | Final Assembly & Testing |
| 911 | 10.8 | **not in the app** | — |
| 1027 | 9.2 | Complete | Duplicate MPC Assembly Machine + FOX |
| 1054 | 8.8 | Complete | ADAC3 – WIT |
| 859 | 8.3 | Complete | FK0555 Novi Coil Assy |
| 925 | 6.5 | **not in the app** | — |
| 1014 | 6.1 | Complete | Replicatd Auto Bubbler QTY 10 |
| 1088 | 4.9 | Complete | CYBiFT |
| 1077 | 4.2 | Complete | Miscellaneous Seamer Improvements and Upgrades |
| 2026 | 4.1 | **not in the app** | — |
| 976 | 3.6 | Complete | Replicated Auto Bubblers |
| 992 | 3.5 | Complete | EP10 QTY (3) |
| 1020 | 2.6 | Complete | S7 Wet Hi-Pot |
| 1053 | 1.8 | Complete | Vertebrae Assembly, Phase 2 Automation |
| 1086 | 1.5 | Complete | Laser Cable Cutter Cell |
| 1031 | 1.3 | Complete | Press 10 Revitalization |
| 1156 | 0.2 | Active | Duplicate PAIVI with Modifications |

### `80-412` — 577.8h across 27 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1116 | 70.9 | Complete | Flexible Brazing Machine |
| 1105 | 62.1 | Active | Clip-iT Retrofit |
| 964 | 48.5 | **not in the app** | — |
| 996 | 45 | Complete | GM Assembly Machine |
| 1003 | 42 | Complete | Automated Picking and Cracking Machine with Two Dials |
| 925 | 37.1 | **not in the app** | — |
| 1020 | 34 | Complete | S7 Wet Hi-Pot |
| 859 | 34 | Complete | FK0555 Novi Coil Assy |
| 1029 | 25.3 | Complete | Next Generation Casting Machine QTY(3) |
| 934 | 19.2 | **not in the app** | — |
| 928 | 17.9 | Complete | Final Assembly & Testing |
| 927 | 17.3 | Complete | Main Coil Assembly |
| 861 | 16.4 | Complete | Automated Packaging Machine |
| 1108 | 16 | Complete | Vitamix Modification |
| 4000 | 15.1 | Active | Non-Billable |
| 1054 | 11.8 | Complete | ADAC3 – WIT |
| 911 | 11 | **not in the app** | — |
| 1027 | 10.8 | Complete | Duplicate MPC Assembly Machine + FOX |
| 1070 | 10.2 | Complete | Replicated Auto Bubbler |
| 1096 | 9.9 | Complete | SDC High Temp Light Soak Chamber |
| 1114 | 7.1 | Complete | Bullfrog Powder Line |
| 1079 | 4.9 | Complete | Duplicate Paragon Assembly Cell QTY (2) |
| 735 | 3.7 | **not in the app** | — |
| 1120 | 3.6 | Complete | Bleep Sleep Assembly Machine Upgrades |
| 1081 | 3.1 | Complete | Single Gen 2 Light Soak QTY (8) |
| 1067 | 1 | Complete | Baseline Assembly Cell |
| 1125 | 0.1 | Active | Upgraded Foil Applicator Machine |

### `90-414` — 217.1h across 13 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 2025 | 84 | Active | 2025 Spare Parts |
| 2026 | 73.1 | **not in the app** | — |
| 1107 | 12.5 | Complete | Spiral Trap Assy |
| 1101 | 12.3 | Active | Coil Staker |
| 1117 | 8.9 | Complete | Automated Feed Set Assembly |
| 988 | 8.4 | Complete | Mosquito Repellent Refill Packaging Machine |
| 911 | 6.5 | **not in the app** | — |
| 1120 | 4.9 | Complete | Bleep Sleep Assembly Machine Upgrades |
| 1116 | 1.9 | Complete | Flexible Brazing Machine |
| 1027 | 1.4 | Complete | Duplicate MPC Assembly Machine + FOX |
| 996 | 1.3 | Complete | GM Assembly Machine |
| 927 | 1.1 | Complete | Main Coil Assembly |
| 859 | 0.7 | Complete | FK0555 Novi Coil Assy |

### `70-414` — 202.9h across 6 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1030 | 103.3 | Complete | 10 Pack Boxing Machine |
| 1067 | 61 | Complete | Baseline Assembly Cell |
| 1107 | 19.5 | Complete | Spiral Trap Assy |
| 1058 | 8 | Complete | Instant Ink Fulfillment Automation |
| 1131 | 6.9 | Active | Tile Grinder Automatic Loader and Unloader |
| 1054 | 4.3 | Complete | ADAC3 – WIT |

### `10-118` — 135.3h across 2 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 4000 | 135.1 | Active | Non-Billable |
| 1101 | 0.2 | Active | Coil Staker |

### `90-211` — 124.7h across 26 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1097 | 19.9 | Complete | SDC High Temp Bi-Facial Light Soak Chamber |
| 1054 | 15.5 | Complete | ADAC3 – WIT |
| 1058 | 14 | Complete | Instant Ink Fulfillment Automation |
| 1130 | 11.3 | Active | Compact Single Sided Light Soak |
| 976 | 6.9 | Complete | Replicated Auto Bubblers |
| 1108 | 6.8 | Complete | Vitamix Modification |
| 1104 | 6.5 | Active | Andi 1 & Andi 2 Replacement Line |
| 1120 | 6.1 | Complete | Bleep Sleep Assembly Machine Upgrades |
| 1142 | 5.5 | Active | Dual Sided Light Soak Chambers |
| 1036 | 5.2 | Complete | Light Soak Chamber |
| 988 | 4.8 | Complete | Mosquito Repellent Refill Packaging Machine |
| 2025 | 4 | Active | 2025 Spare Parts |
| 1116 | 3.5 | Complete | Flexible Brazing Machine |
| 1080 | 2 | Complete | Manually Loaded Box Closer |
| 1107 | 2 | Complete | Spiral Trap Assy |
| 1118 | 2 | Active | AIR Loop Assembly |
| 1125 | 2 | Active | Upgraded Foil Applicator Machine |
| 1081 | 1.8 | Complete | Single Gen 2 Light Soak QTY (8) |
| 1082 | 1.3 | Complete | BiFacial Gen 2 Light Soak QTY (2) |
| 1075 | 1 | Complete | SDC Clip-iT 1.1 QTY (8) |
| 1106 | 0.8 | Active | SDC Clip-iT 1.1 QTY (8) |
| 1121 | 0.6 | Complete | E-Module Solar Simulator |
| 1134 | 0.5 | Active | S7 Rinse Dry |
| 1042 | 0.5 | Complete | Bi-Facial Light Soak Chamber Low Temp |
| 996 | 0.2 | Complete | GM Assembly Machine |
| 1088 | 0.1 | Complete | CYBiFT |

### `1-312` — 116.5h across 7 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1096 | 32 | Complete | SDC High Temp Light Soak Chamber |
| 1103 | 32 | Complete | Tip-Up Packaging |
| 1086 | 24 | Complete | Laser Cable Cutter Cell |
| 1066 | 16 | Complete | Mar-Bal Press Loader |
| 1150 | 4.5 | Active | USEC Heat Shield Spiral Machine (Upgrades) |
| 1064 | 4.5 | Complete | S7 Reflectance |
| 1090 | 3.5 | **not in the app** | — |

### `90-411` — 78.2h across 6 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 2026 | 49 | **not in the app** | — |
| 1105 | 21.1 | Active | Clip-iT Retrofit |
| 2025 | 6.4 | Active | 2025 Spare Parts |
| 995 | 1.1 | Complete | AutoTape and QDTape Assembly Machines |
| 998 | 0.5 | Complete | GM Secondary Terminal Machine |
| 972 | 0.2 | Complete | Retrofit Automated Nasal Port Assembly Machine |

### `80-414` — 77.9h across 12 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 861 | 20.5 | Complete | Automated Packaging Machine |
| 1042 | 13.2 | Complete | Bi-Facial Light Soak Chamber Low Temp |
| 1067 | 10.7 | Complete | Baseline Assembly Cell |
| 1120 | 8 | Complete | Bleep Sleep Assembly Machine Upgrades |
| 1054 | 6.2 | Complete | ADAC3 – WIT |
| 1058 | 6 | Complete | Instant Ink Fulfillment Automation |
| 6000 | 4.8 | Active | Bellco Feeders |
| 923 | 4.2 | **not in the app** | — |
| 2025 | 3.4 | Active | 2025 Spare Parts |
| 1131 | 0.6 | Active | Tile Grinder Automatic Loader and Unloader |
| 1127 | 0.3 | Active | Hail Impact QTY (3) |
| 995 | 0 | Complete | AutoTape and QDTape Assembly Machines |

### `70-516` — 77.8h across 4 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1103 | 31.5 | Complete | Tip-Up Packaging |
| 1067 | 25 | Complete | Baseline Assembly Cell |
| 1074 | 19.8 | Complete | Automated Packaging Machine |
| 1058 | 1.5 | Complete | Instant Ink Fulfillment Automation |

### `5-111` — 71h across 7 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1101 | 44.5 | Active | Coil Staker |
| 1086 | 17.5 | Complete | Laser Cable Cutter Cell |
| 1110 | 3 | Complete | Robotic DFL Spray Machine |
| 1154 | 2 | Active | Field Hockey System |
| 1092 | 1.8 | Complete | Vial Feeding Automation |
| 1145 | 1.3 | Active | Primary Packaging Load Automation |
| 1111 | 1 | Complete | Duplicate Refill Machine |

### `1-311` — 44.5h across 4 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1071 | 19 | Complete | Replicated Auto Bubbler QTY (8) |
| 4000 | 17.5 | Active | Non-Billable |
| 1060 | 4.5 | Complete | S7 Dynamic Load |
| 1044 | 3.5 | Complete | Clip-iT BIFI Gen 2.0 (Biscuit) |

### `80-313` — 34.8h across 3 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1116 | 24.1 | Complete | Flexible Brazing Machine |
| 1120 | 6.8 | Complete | Bleep Sleep Assembly Machine Upgrades |
| 1089 | 4 | Complete | ShurTape Auto Boxing Line |

### `80-516` — 33.5h across 4 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 861 | 14 | Complete | Automated Packaging Machine |
| 1015 | 9.5 | Complete | Duplicate De-Flashing System |
| 867 | 8 | Complete | Permasert 2.0 Automation |
| 907 | 2 | **not in the app** | — |

### `80-312` — 28.3h across 3 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 996 | 16.3 | Complete | GM Assembly Machine |
| 1054 | 8 | Complete | ADAC3 – WIT |
| 1067 | 4 | Complete | Baseline Assembly Cell |

### `70-413` — 25h across 2 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1030 | 23.4 | Complete | 10 Pack Boxing Machine |
| 1067 | 1.6 | Complete | Baseline Assembly Cell |

### `10-112` — 22.5h across 4 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1152 | 10.8 | Active | Container Filling Machine |
| 4000 | 7.8 | Active | Non-Billable |
| 1108 | 3.7 | Complete | Vitamix Modification |
| 1044 | 0.2 | Complete | Clip-iT BIFI Gen 2.0 (Biscuit) |

### `Not Defined-311` — 18.3h across 3 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1081 | 8 | Complete | Single Gen 2 Light Soak QTY (8) |
| 4000 | 6.8 | Active | Non-Billable |
| 2025 | 3.5 | Active | 2025 Spare Parts |

### `10-119` — 12.1h across 2 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1072 | 8.6 | Complete | Duplicate 60L Seamer Conversion QTY (2) |
| 4000 | 3.5 | Active | Non-Billable |

### `1-100` — 8h across 1 project

| Job Id | hours | status | project |
|---|---:|---|---|
| 1066 | 8 | Complete | Mar-Bal Press Loader |

### `90-412` — 7.8h across 1 project

| Job Id | hours | status | project |
|---|---:|---|---|
| 2026 | 7.8 | **not in the app** | — |

### `Not Defined-Not Defined` — 6.4h across 2 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 4000 | 5.9 | Active | Non-Billable |
| 2025 | 0.5 | Active | 2025 Spare Parts |

### `70-517` — 6.1h across 1 project

| Job Id | hours | status | project |
|---|---:|---|---|
| 1107 | 6.1 | Complete | Spiral Trap Assy |

### `12-311` — 5h across 1 project

| Job Id | hours | status | project |
|---|---:|---|---|
| 7000 | 5 | Active | Team Inititives |

### `Not Defined-211` — 4.7h across 3 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 4000 | 2 | Active | Non-Billable |
| 1107 | 1.5 | Complete | Spiral Trap Assy |
| 2025 | 1.2 | Active | 2025 Spare Parts |

### `1-118` — 4h across 1 project

| Job Id | hours | status | project |
|---|---:|---|---|
| 1104 | 4 | Active | Andi 1 & Andi 2 Replacement Line |

### `90-311` — 4h across 3 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 4000 | 2 | Active | Non-Billable |
| 923 | 1 | **not in the app** | — |
| 2026 | 1 | **not in the app** | — |

### `80-112` — 0.7h across 1 project

| Job Id | hours | status | project |
|---|---:|---|---|
| 1044 | 0.7 | Complete | Clip-iT BIFI Gen 2.0 (Biscuit) |

## B. Counted in a Standard Fees pool, but not against the job

These are not lost — they are in the four company-wide pools (PM, Manufacturing, Warranty Engineering, Warranty Shop), which is by design: that work is planned in one pot rather than job by job, which is exactly why the ETC grid has no column for it. Listed because the hours still never appear on a project row.

| code | hours | projects |
|---|---:|---:|
| `70-311` | 2,196.6 | 50 |
| `70-411` | 1,199.2 | 18 |
| `70-211` | 1,193.4 | 30 |
| `10-111` | 855.9 | 17 |
| `70-412` | 752.7 | 20 |
| `70-313` | 23 | 4 |
| `70-312` | 4 | 2 |

### `70-311` — 2,196.6h across 50 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1067 | 751.7 | Complete | Baseline Assembly Cell |
| 1030 | 255.3 | Complete | 10 Pack Boxing Machine |
| 1074 | 159 | Complete | Automated Packaging Machine |
| 1079 | 156.2 | Complete | Duplicate Paragon Assembly Cell QTY (2) |
| 995 | 116.3 | Complete | AutoTape and QDTape Assembly Machines |
| 1086 | 105 | Complete | Laser Cable Cutter Cell |
| 1107 | 94.5 | Complete | Spiral Trap Assy |
| 1054 | 82.5 | Complete | ADAC3 – WIT |
| 1058 | 78.3 | Complete | Instant Ink Fulfillment Automation |
| 1096 | 42.3 | Complete | SDC High Temp Light Soak Chamber |
| 1062 | 36 | Complete | S7 Wet Hi-Pot |
| 1113 | 32.5 | Complete | Board Tuning Machine |
| 1081 | 31.3 | Complete | Single Gen 2 Light Soak QTY (8) |
| 1108 | 29.8 | Complete | Vitamix Modification |
| 927 | 23.8 | Complete | Main Coil Assembly |
| 1112 | 22.5 | Complete | Mods to Existing Refill Machine |
| 1101 | 21 | Active | Coil Staker |
| 1039 | 19.5 | Complete | Flex Feeder (2) |
| 861 | 17.5 | Complete | Automated Packaging Machine |
| 1069 | 15 | Complete | VMW Machine Retool |
| 1052 | 11 | Complete | Three ZIP Seaming Systems |
| 1103 | 10.5 | Complete | Tip-Up Packaging |
| 1053 | 9 | Complete | Vertebrae Assembly, Phase 2 Automation |
| 925 | 8.5 | **not in the app** | — |
| 1057 | 7.5 | Complete | EP10 Auto Stent QTY (2) |
| 1110 | 6 | Complete | Robotic DFL Spray Machine |
| 1080 | 6 | Complete | Manually Loaded Box Closer |
| 1075 | 5.5 | Complete | SDC Clip-iT 1.1 QTY (8) |
| 1114 | 4 | Complete | Bullfrog Powder Line |
| 1150 | 3.5 | Active | USEC Heat Shield Spiral Machine (Upgrades) |
| 1041 | 3.5 | Complete | 30K Disassembly Tool |
| 1047 | 3 | Complete | Duplicate Clip-iT's QTY (15) |
| 907 | 3 | **not in the app** | — |
| 1072 | 3 | Complete | Duplicate 60L Seamer Conversion QTY (2) |
| 1042 | 2.5 | Complete | Bi-Facial Light Soak Chamber Low Temp |
| 1056 | 2.5 | Complete | S7 Shade-O-Matic QTY（4） |
| 1082 | 2.3 | Complete | BiFacial Gen 2 Light Soak QTY (2) |
| 1063 | 2 | Complete | S7 Autosweeper |
| 1105 | 2 | Active | Clip-iT Retrofit |
| 1120 | 2 | Complete | Bleep Sleep Assembly Machine Upgrades |
| 1046 | 1 | Complete | Duplicate Benchtop Zip Paper Lid Closing Machine |
| 1060 | 1 | Complete | S7 Dynamic Load |
| 1064 | 1 | Complete | S7 Reflectance |
| 1106 | 1 | Active | SDC Clip-iT 1.1 QTY (8) |
| 4000 | 1 | Active | Non-Billable |
| 1083 | 1 | Active | SDC Showroom |
| 1090 | 1 | **not in the app** | — |
| 1097 | 1 | Complete | SDC High Temp Bi-Facial Light Soak Chamber |
| 1117 | 1 | Complete | Automated Feed Set Assembly |
| 964 | 0.8 | **not in the app** | — |

### `70-411` — 1,199.2h across 18 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1096 | 641.2 | Complete | SDC High Temp Light Soak Chamber |
| 1047 | 129.1 | Complete | Duplicate Clip-iT's QTY (15) |
| 1097 | 114.9 | Complete | SDC High Temp Bi-Facial Light Soak Chamber |
| 1067 | 87.8 | Complete | Baseline Assembly Cell |
| 1081 | 76.5 | Complete | Single Gen 2 Light Soak QTY (8) |
| 1103 | 22 | Complete | Tip-Up Packaging |
| 1054 | 21.6 | Complete | ADAC3 – WIT |
| 1030 | 21.5 | Complete | 10 Pack Boxing Machine |
| 1105 | 20.9 | Active | Clip-iT Retrofit |
| 1086 | 13.7 | Complete | Laser Cable Cutter Cell |
| 1088 | 12 | Complete | CYBiFT |
| 995 | 10.9 | Complete | AutoTape and QDTape Assembly Machines |
| 948 | 9.1 | Complete | Automated Radius Zone Repellant Fill & Assembly |
| 988 | 7.6 | Complete | Mosquito Repellent Refill Packaging Machine |
| 1107 | 6.9 | Complete | Spiral Trap Assy |
| 1024 | 1.7 | Complete | Vertebrae Assembly |
| 1122 | 1.5 | Active | CAFI |
| 1115 | 0.3 | Complete | Wet Hi-Pot |

### `70-211` — 1,193.4h across 30 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1067 | 271.2 | Complete | Baseline Assembly Cell |
| 995 | 224.2 | Complete | AutoTape and QDTape Assembly Machines |
| 1030 | 157.5 | Complete | 10 Pack Boxing Machine |
| 1058 | 137.9 | Complete | Instant Ink Fulfillment Automation |
| 1054 | 81.7 | Complete | ADAC3 – WIT |
| 1107 | 47 | Complete | Spiral Trap Assy |
| 1086 | 34 | Complete | Laser Cable Cutter Cell |
| 1081 | 29.3 | Complete | Single Gen 2 Light Soak QTY (8) |
| 1097 | 28.5 | Complete | SDC High Temp Bi-Facial Light Soak Chamber |
| 1103 | 22.3 | Complete | Tip-Up Packaging |
| 1074 | 21.4 | Complete | Automated Packaging Machine |
| 1088 | 19.1 | Complete | CYBiFT |
| 1113 | 17.8 | Complete | Board Tuning Machine |
| 1075 | 16.3 | Complete | SDC Clip-iT 1.1 QTY (8) |
| 1096 | 13.4 | Complete | SDC High Temp Light Soak Chamber |
| 996 | 11.3 | Complete | GM Assembly Machine |
| 1082 | 11 | Complete | BiFacial Gen 2 Light Soak QTY (2) |
| 988 | 9.5 | Complete | Mosquito Repellent Refill Packaging Machine |
| 1060 | 9.5 | Complete | S7 Dynamic Load |
| 1024 | 7 | Complete | Vertebrae Assembly |
| 991 | 6.3 | Complete | EP10 (No Tooling) |
| 1111 | 3.7 | Complete | Duplicate Refill Machine |
| 972 | 3 | Complete | Retrofit Automated Nasal Port Assembly Machine |
| 861 | 2.9 | Complete | Automated Packaging Machine |
| 1121 | 2.6 | Complete | E-Module Solar Simulator |
| 1062 | 2 | Complete | S7 Wet Hi-Pot |
| 1036 | 1 | Complete | Light Soak Chamber |
| 1070 | 0.9 | Complete | Replicated Auto Bubbler |
| 1066 | 0.8 | Complete | Mar-Bal Press Loader |
| 1027 | 0.5 | Complete | Duplicate MPC Assembly Machine + FOX |

### `10-111` — 855.9h across 17 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 4000 | 678.7 | Active | Non-Billable |
| 1101 | 49.8 | Active | Coil Staker |
| 1150 | 32 | Active | USEC Heat Shield Spiral Machine (Upgrades) |
| 1145 | 17.8 | Active | Primary Packaging Load Automation |
| 1067 | 15.3 | Complete | Baseline Assembly Cell |
| 1108 | 11.8 | Complete | Vitamix Modification |
| 1121 | 11.6 | Complete | E-Module Solar Simulator |
| 1154 | 10 | Active | Field Hockey System |
| 1120 | 9 | Complete | Bleep Sleep Assembly Machine Upgrades |
| 1086 | 7.5 | Complete | Laser Cable Cutter Cell |
| 1104 | 6 | Active | Andi 1 & Andi 2 Replacement Line |
| 1092 | 1.8 | Complete | Vial Feeding Automation |
| 1146 | 1.8 | Active | Secondary Packaging Load Automation |
| 1081 | 1.5 | Complete | Single Gen 2 Light Soak QTY (8) |
| 1110 | 1 | Complete | Robotic DFL Spray Machine |
| 1107 | 0.5 | Complete | Spiral Trap Assy |
| 1003 | 0.1 | Complete | Automated Picking and Cracking Machine with Two Dials |

### `70-412` — 752.7h across 20 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1096 | 206 | Complete | SDC High Temp Light Soak Chamber |
| 1058 | 131.2 | Complete | Instant Ink Fulfillment Automation |
| 1067 | 84.9 | Complete | Baseline Assembly Cell |
| 995 | 72.4 | Complete | AutoTape and QDTape Assembly Machines |
| 1112 | 34.8 | Complete | Mods to Existing Refill Machine |
| 1030 | 31.8 | Complete | 10 Pack Boxing Machine |
| 1054 | 24.5 | Complete | ADAC3 – WIT |
| 1097 | 23 | Complete | SDC High Temp Bi-Facial Light Soak Chamber |
| 1081 | 22.5 | Complete | Single Gen 2 Light Soak QTY (8) |
| 1075 | 21.8 | Complete | SDC Clip-iT 1.1 QTY (8) |
| 861 | 21.1 | Complete | Automated Packaging Machine |
| 1105 | 20 | Active | Clip-iT Retrofit |
| 1082 | 14.5 | Complete | BiFacial Gen 2 Light Soak QTY (2) |
| 1121 | 11.4 | Complete | E-Module Solar Simulator |
| 1088 | 9.8 | Complete | CYBiFT |
| 1047 | 9.8 | Complete | Duplicate Clip-iT's QTY (15) |
| 1101 | 4.8 | Active | Coil Staker |
| 1107 | 4.7 | Complete | Spiral Trap Assy |
| 1103 | 3 | Complete | Tip-Up Packaging |
| 964 | 0.6 | **not in the app** | — |

### `70-313` — 23h across 4 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1058 | 12 | Complete | Instant Ink Fulfillment Automation |
| 1067 | 7 | Complete | Baseline Assembly Cell |
| 1030 | 3.5 | Complete | 10 Pack Boxing Machine |
| 1120 | 0.5 | Complete | Bleep Sleep Assembly Machine Upgrades |

### `70-312` — 4h across 2 projects

| Job Id | hours | status | project |
|---|---:|---|---|
| 1062 | 2 | Complete | S7 Wet Hi-Pot |
| 1103 | 2 | Complete | Tip-Up Packaging |

## C. Booked to Job Id `NOT DEFINED`

No project can be named for these — the punch itself carries no job. This is a Paylocity coding problem rather than an app modelling one, and it is the bucket worth chasing upstream: `JobMonthlyActualHours.overridden` exists to correct individual months by hand once the real job is known.

| code | hours | reaches a job column if fixed? |
|---|---:|---|
| `10-414` | 1,439.9 | **yes** |
| `10-400` | 954.2 | no |
| `1-400` | 772.1 | no |
| `1-118` | 751.8 | no |
| `10-118` | 646.9 | no |
| `10-211` | 445.4 | **yes** |
| `1-100` | 401.1 | no |
| `5-119` | 350.1 | no |
| `10-412` | 308.9 | **yes** |
| `80-311` | 273.2 | no |
| `10-411` | 151.7 | **yes** |
| `80-211` | 85.5 | no |
| `80-411` | 63.2 | no |
| `80-414` | 32.6 | no |
| `10-313` | 26.8 | **yes** |
| `10-413` | 23 | **yes** |
| `10-312` | 16 | **yes** |
| `50-311` | 13 | **yes** |
| `Not Defined-Not Defined` | 12.5 | no |
| `90-211` | 10.6 | no |
| `80-112` | 9 | no |
| `10-111` | 8.5 | pool only |
| `10-112` | 8.1 | no |
| `90-411` | 8 | no |
| `10-119` | 7.8 | no |
| `90-414` | 6.7 | no |
| `80-412` | 6.3 | no |
| `Not Defined-311` | 6 | no |
| `70-211` | 4.7 | pool only |
| `1-311` | 4 | no |
| `5-100` | 3.5 | no |
| `40-311` | 3.5 | **yes** |
| `70-311` | 3 | pool only |
| `70-411` | 2.3 | pool only |
| `40-211` | 1 | **yes** |

### `10-414` — 1,439.9h

| month | hours |
|---|---:|
| 2025-03 | 81.2 |
| 2025-04 | 556.8 |
| 2025-05 | 183 |
| 2025-06 | 183.8 |
| 2025-07 | 16 |
| 2025-08 | 0.5 |
| 2025-09 | 0 |
| 2025-10 | 9.5 |
| 2025-11 | 0 |
| 2025-12 | 5.5 |
| 2026-01 | 4.5 |
| 2026-02 | 18 |
| 2026-04 | 0 |
| 2026-05 | 31.5 |
| 2026-06 | 176.5 |
| 2026-07 | 172.7 |

### `10-400` — 954.2h

| month | hours |
|---|---:|
| 2025-03 | 11.5 |
| 2025-04 | 47 |
| 2025-05 | 155 |
| 2025-06 | 32.1 |
| 2026-03 | 95.9 |
| 2026-04 | 112.3 |
| 2026-05 | 152.4 |
| 2026-06 | 180 |
| 2026-07 | 168 |

### `1-400` — 772.1h

| month | hours |
|---|---:|
| 2025-06 | 125.2 |
| 2025-07 | 132.5 |
| 2025-08 | 151.8 |
| 2025-09 | 120.3 |
| 2025-10 | 123.8 |
| 2025-11 | 91.8 |
| 2025-12 | 18.7 |
| 2026-07 | 8 |

### `1-118` — 751.8h

| month | hours |
|---|---:|
| 2025-02 | 574.3 |
| 2025-03 | 8 |
| 2026-02 | 18 |
| 2026-03 | 33 |
| 2026-04 | 39 |
| 2026-05 | 21 |
| 2026-06 | 22.5 |
| 2026-07 | 36 |

### `10-118` — 646.9h

| month | hours |
|---|---:|
| 2025-02 | 79.5 |
| 2025-03 | 517 |
| 2025-04 | 50.2 |
| 2025-07 | 0.2 |

### `10-211` — 445.4h

| month | hours |
|---|---:|
| 2025-02 | 12 |
| 2025-03 | 0.9 |
| 2025-05 | 0 |
| 2025-07 | 0.3 |
| 2025-09 | 0.6 |
| 2025-10 | 6.2 |
| 2025-12 | 0.5 |
| 2026-05 | 74.3 |
| 2026-06 | 183.7 |
| 2026-07 | 166.9 |

### `1-100` — 401.1h

| month | hours |
|---|---:|
| 2025-02 | 98 |
| 2025-03 | 59.9 |
| 2025-04 | 75 |
| 2025-05 | 52.8 |
| 2025-06 | 55.8 |
| 2025-07 | 59.6 |

### `5-119` — 350.1h

| month | hours |
|---|---:|
| 2026-05 | 23 |
| 2026-06 | 175.1 |
| 2026-07 | 152 |

### `10-412` — 308.9h

| month | hours |
|---|---:|
| 2025-02 | 1.2 |
| 2025-03 | 68.7 |
| 2025-04 | 47.5 |
| 2025-05 | 61.1 |
| 2025-07 | 22.1 |
| 2025-08 | 34.3 |
| 2025-12 | 6.8 |
| 2026-02 | 0.4 |
| 2026-03 | 4.5 |
| 2026-05 | 22 |
| 2026-06 | 40 |
| 2026-07 | 0.2 |

### `80-311` — 273.2h

| month | hours |
|---|---:|
| 2025-02 | 39 |
| 2025-03 | 45 |
| 2025-04 | 16.3 |
| 2025-05 | 39.8 |
| 2025-06 | 50.3 |
| 2025-07 | 8 |
| 2025-09 | 4 |
| 2025-11 | 2 |
| 2025-12 | 11 |
| 2026-01 | 31 |
| 2026-02 | 12 |
| 2026-04 | 8 |
| 2026-05 | 1.5 |
| 2026-06 | 5.5 |

### `10-411` — 151.7h

| month | hours |
|---|---:|
| 2025-02 | 10.4 |
| 2025-03 | 29.5 |
| 2025-04 | 70.7 |
| 2025-05 | 0.4 |
| 2025-06 | 0.4 |
| 2025-07 | 0 |
| 2025-08 | 0.3 |
| 2025-09 | 0.2 |
| 2025-10 | 8.5 |
| 2025-11 | 0.3 |
| 2025-12 | 12.5 |
| 2026-01 | 2.6 |
| 2026-02 | 0.6 |
| 2026-03 | 0.1 |
| 2026-04 | 3.5 |
| 2026-05 | 8 |
| 2026-07 | 3.5 |

### `80-211` — 85.5h

| month | hours |
|---|---:|
| 2025-04 | 8.3 |
| 2025-06 | 2.3 |
| 2025-09 | 24.4 |
| 2025-10 | 1 |
| 2025-11 | 5.5 |
| 2025-12 | 44 |

### `80-411` — 63.2h

| month | hours |
|---|---:|
| 2025-03 | 21.6 |
| 2025-10 | 9.5 |
| 2025-11 | 17.4 |
| 2025-12 | 8 |
| 2026-07 | 6.6 |

### `80-414` — 32.6h

| month | hours |
|---|---:|
| 2025-07 | 21.6 |
| 2025-10 | 11 |

### `10-313` — 26.8h

| month | hours |
|---|---:|
| 2025-02 | 0.7 |
| 2025-03 | 2.8 |
| 2026-05 | 5.6 |
| 2026-06 | 11.7 |
| 2026-07 | 5.9 |

### `10-413` — 23h

| month | hours |
|---|---:|
| 2025-03 | 10 |
| 2025-05 | 0.8 |
| 2025-07 | 0.9 |
| 2025-08 | 0.2 |
| 2025-09 | 0.1 |
| 2025-10 | 11.3 |

### `10-312` — 16h

| month | hours |
|---|---:|
| 2025-02 | 0.3 |
| 2025-03 | 1.2 |
| 2025-10 | 4.5 |
| 2026-05 | 2.4 |
| 2026-06 | 5 |
| 2026-07 | 2.6 |

### `50-311` — 13h

| month | hours |
|---|---:|
| 2025-02 | 13 |

### `Not Defined-Not Defined` — 12.5h

| month | hours |
|---|---:|
| 2025-02 | 4.5 |
| 2026-05 | 8 |

### `90-211` — 10.6h

| month | hours |
|---|---:|
| 2025-06 | 10.6 |

### `80-112` — 9h

| month | hours |
|---|---:|
| 2026-01 | 9 |

### `10-111` — 8.5h

| month | hours |
|---|---:|
| 2026-06 | 8.5 |

### `10-112` — 8.1h

| month | hours |
|---|---:|
| 2025-03 | 0.1 |
| 2025-04 | 8 |

### `90-411` — 8h

| month | hours |
|---|---:|
| 2025-05 | 8 |

### `10-119` — 7.8h

| month | hours |
|---|---:|
| 2025-03 | 7.8 |

### `90-414` — 6.7h

| month | hours |
|---|---:|
| 2026-02 | 6.7 |

### `80-412` — 6.3h

| month | hours |
|---|---:|
| 2025-04 | 4.4 |
| 2025-05 | 0.1 |
| 2025-12 | 0.1 |
| 2026-02 | 1.7 |

### `Not Defined-311` — 6h

| month | hours |
|---|---:|
| 2025-03 | 6 |

### `70-211` — 4.7h

| month | hours |
|---|---:|
| 2025-06 | 4.7 |

### `1-311` — 4h

| month | hours |
|---|---:|
| 2025-02 | 4 |

### `5-100` — 3.5h

| month | hours |
|---|---:|
| 2025-03 | 3.5 |

### `40-311` — 3.5h

| month | hours |
|---|---:|
| 2025-03 | 3.5 |

### `70-311` — 3h

| month | hours |
|---|---:|
| 2025-02 | 1 |
| 2026-01 | 2 |

### `70-411` — 2.3h

| month | hours |
|---|---:|
| 2025-04 | 2.3 |

### `40-211` — 1h

| month | hours |
|---|---:|
| 2025-02 | 1 |

---

Regenerate with `npx tsx scripts/report-unmapped-hours.ts`.
