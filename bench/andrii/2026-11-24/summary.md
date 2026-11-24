# Andrii js-reactivity-benchmark rerun -- summary (REPORTED)

Ranks within each table, not absolute times. Ratios are geomeans over ranked rows (complete, all
validation "passed", none capped), over the 7 adapters.

## Leg leg-node26

- node v26.8.2, v8 14.6.202.34-node.28, darwin/arm64, cpu Apple M4 Pro
- bundleSha256 0ab7cb36431b6d87885680ee10cfbc7f5a18af630c7c3e05e206892ab4cea647, sourceCommit 12f169b0f7d25de343433e3199c27d0472136185, rounds 3, profile quick
- packages: lite-signal=1.5.2, lite-signal-eager=1.5.2, lite-signal-1.6=1.6.0-candidate+6bcaaf1.a7202c9b, lite-signal-eager-1.6=1.6.0-candidate+6bcaaf1.a7202c9b, lite-signal-reset=1.6.0-candidate+6bcaaf1.a7202c9b, lite-signal-eager-reset=1.6.0-candidate+6bcaaf1.a7202c9b, alien-signals=3.2.1
- rows: total 51, ranked 51, void 0, capped 0
- records per adapter: lite-signal=51, lite-signal-eager=51, lite-signal-1.6=51, lite-signal-eager-1.6=51, lite-signal-reset=51, lite-signal-eager-reset=51, alien-signals=51

### LAZY

| rank | adapter | geomean / alien | geomean / best (upstream style) | row wins |
|---:|---|---:|---:|---:|
| 1 | alien-signals | 1.00000000 | 1.02410135 | 44 |
| 2 | lite-signal-reset | 1.31839428 | 1.35016935 | 1 |
| 3 | lite-signal-1.6 | 1.58490987 | 1.62310833 | 3 |
| 4 | lite-signal | 1.61263655 | 1.65150327 | 3 |

### EAGER

| rank | adapter | geomean / alien | geomean / best (upstream style) | row wins |
|---:|---|---:|---:|---:|
| 1 | alien-signals | 1.00000000 | 1.01965731 | 45 |
| 2 | lite-signal-eager-reset | 1.43135906 | 1.45949573 | 2 |
| 3 | lite-signal-eager | 1.55447107 | 1.58502778 | 2 |
| 4 | lite-signal-eager-1.6 | 1.60746274 | 1.63906113 | 2 |

### OVERALL (all 7 adapters)

| rank | adapter | geomean / alien | geomean / best (upstream style) | row wins |
|---:|---|---:|---:|---:|
| 1 | alien-signals | 1.00000000 | 1.02484259 | 44 |
| 2 | lite-signal-reset | 1.31839428 | 1.35114661 | 1 |
| 3 | lite-signal-eager-reset | 1.43135906 | 1.46691773 | 0 |
| 4 | lite-signal-eager | 1.55447107 | 1.59308816 | 1 |
| 5 | lite-signal-1.6 | 1.58490987 | 1.62428314 | 2 |
| 6 | lite-signal-eager-1.6 | 1.60746274 | 1.64739628 | 0 |
| 7 | lite-signal | 1.61263655 | 1.65269863 | 3 |

### 1.6 vs 1.5.2 and reset vs 1.6 destroy (per row, round range)

#### lite-signal-1.6/lite-signal

geomean 0.98280661 (per-row min 0.79813879, max 1.23613258, 51 rows)

| row | lite-signal-1.6 / lite-signal | round range |
|---|---:|---|
| avoidablePropagation | 1.06478876 | 0.95549849..1.12340870 |
| broadPropagation | 1.02090704 | 1.01769995..1.04768430 |
| deepPropagation | 0.99339324 | 0.97801575..1.02944077 |
| diamond | 1.05491976 | 1.02104696..1.06795200 |
| mux | 0.93162693 | 0.91457754..0.96215257 |
| repeatedObservers | 1.10744751 | 1.10017886..1.12908560 |
| triangle | 0.91907612 | 0.90470375..0.92497736 |
| unstable | 0.91806502 | 0.91387631..0.93936368 |
| manyEffectsFromOneSource | 0.93551987 | 0.90834843..0.94142720 |
| manySourcesIntoOneComputedEffectWithDirect | 1.00671959 | 1.00023629..1.02064486 |
| manySourcesIntoOneComputedEffect | 1.00848720 | 0.98977347..1.02168913 |
| manySourcesIntoOneDirectEffect | 0.99948536 | 0.98775870..1.00090918 |
| molBench | 0.99631676 | 0.95282031..1.05497597 |
| mutable-object/immutable replacement | 1.01151736 | 1.00074386..1.02473247 |
| mutable-object/in-place versioned | 1.04378981 | 1.03693177..1.05454934 |
| createDataSignals | 0.90426927 | 0.83518696..0.92887566 |
| createComputations0to1 | 0.84070328 | 0.81509303..0.86751102 |
| createComputations1to1 | 0.97671622 | 0.96951663..1.07376667 |
| createComputations2to1 | 0.98547043 | 0.97867131..1.00825809 |
| createComputations4to1 | 0.91805130 | 0.90950641..0.94749570 |
| createComputations1000to1 | 1.06151117 | 0.99965135..1.11012731 |
| createComputations1to2 | 1.08824578 | 1.02561408..1.10217131 |
| createComputations1to4 | 1.03861714 | 1.01889018..1.04896920 |
| createComputations1to8 | 1.04876110 | 1.01756946..1.06479425 |
| createComputations1to1000 | 0.84207673 | 0.83466588..0.87011608 |
| updateComputations1to1 | 1.11144759 | 1.11034508..1.11629160 |
| updateComputations2to1 | 1.08507967 | 1.08170110..1.09179920 |
| updateComputations4to1 | 1.07273449 | 1.06502596..1.09767391 |
| updateComputations1000to1 | 0.98651866 | 0.97796917..0.98919222 |
| updateComputations1to2 | 1.12847314 | 1.12049748..1.13479079 |
| updateComputations1to4 | 1.13574986 | 1.13071810..1.13848180 |
| updateComputations1to1000 | 1.09912409 | 1.09246612..1.10404997 |
| dynamic/dashboard selective reads | 0.87847934 | 0.87561191..0.90925390 |
| dynamic/editor derived state | 0.89970607 | 0.89824427..0.90800763 |
| dynamic/kanban board | 0.85870950 | 0.85431776..0.87112797 |
| dynamic/entity detail page | 0.89575646 | 0.88782393..0.93799734 |
| dynamic/layered full-drain cold | 1.00287844 | 0.92836017..1.10154992 |
| dynamic/layered full-drain warm | 1.04378343 | 0.97890620..1.07855605 |
| dynamic/layered burst flush warm | 0.97106353 | 0.87985402..1.01180194 |
| dynamic/stable diamond mesh warm | 0.97238270 | 0.93622385..1.01253762 |
| dynamic/pure pull | 0.93662056 | 0.91929567..0.94867504 |
| dynamic/pure push | 0.86152687 | 0.85703900..0.87997364 |
| dynamic/simple component | 0.99653871 | 0.98224507..1.00660019 |
| dynamic/dynamic component | 0.82163826 | 0.81836708..0.82562463 |
| dynamic/large web app | 0.99838509 | 0.99148388..1.00319086 |
| dynamic/wide dense | 0.79813879 | 0.77845371..0.80615182 |
| dynamic/deep | 0.90856498 | 0.87657366..0.91747105 |
| lifecycle/owned graph create-update-dispose | 1.06023302 | 1.04663896..1.06694659 |
| lifecycle/dispose retained graph | 1.23613258 | 1.22855061..1.24237332 |
| cellx1000 | 0.93870281 | 0.91788024..0.95891989 |
| cellx2500 | 0.92135954 | 0.89434799..0.94794074 |

#### lite-signal-eager-1.6/lite-signal-eager

geomean 1.03408984 (per-row min 0.81604953, max 1.29967377, 51 rows)

| row | lite-signal-eager-1.6 / lite-signal-eager | round range |
|---|---:|---|
| avoidablePropagation | 1.08009529 | 0.97803505..1.17009916 |
| broadPropagation | 1.28632221 | 1.22506346..1.32232593 |
| deepPropagation | 0.98993596 | 0.95732856..1.07270255 |
| diamond | 1.16223108 | 1.13553248..1.17523482 |
| mux | 1.09899756 | 1.09305517..1.16736952 |
| repeatedObservers | 1.09357236 | 1.07636774..1.10332772 |
| triangle | 1.14859616 | 1.06209915..1.18629466 |
| unstable | 1.13765095 | 0.99810866..1.30012074 |
| manyEffectsFromOneSource | 1.01314066 | 0.97789053..1.13790041 |
| manySourcesIntoOneComputedEffectWithDirect | 1.18816273 | 1.07905626..1.54337448 |
| manySourcesIntoOneComputedEffect | 0.99976155 | 0.86180906..1.02651797 |
| manySourcesIntoOneDirectEffect | 1.03370349 | 1.02742211..1.04264053 |
| molBench | 1.01419625 | 0.96713960..1.02363121 |
| mutable-object/immutable replacement | 1.07367297 | 1.06599818..1.10022794 |
| mutable-object/in-place versioned | 1.10359737 | 1.08235593..1.12620897 |
| createDataSignals | 1.02523478 | 1.01624467..1.04009060 |
| createComputations0to1 | 1.06928837 | 1.03287572..1.07234558 |
| createComputations1to1 | 0.96594150 | 0.94411887..0.97711930 |
| createComputations2to1 | 1.00298890 | 0.96861183..1.02687901 |
| createComputations4to1 | 0.99913653 | 0.97571630..1.02851180 |
| createComputations1000to1 | 1.01801770 | 1.01025405..1.03330559 |
| createComputations1to2 | 0.96484347 | 0.94859377..1.00876310 |
| createComputations1to4 | 1.00798672 | 0.99700132..1.04117240 |
| createComputations1to8 | 1.01222940 | 1.00287253..1.02912104 |
| createComputations1to1000 | 1.02669753 | 0.99823784..1.05416710 |
| updateComputations1to1 | 1.09818751 | 1.08953890..1.11202153 |
| updateComputations2to1 | 1.07584196 | 1.06730600..1.09365708 |
| updateComputations4to1 | 1.08119131 | 1.06644222..1.10384658 |
| updateComputations1000to1 | 1.24604821 | 1.24137973..1.40583072 |
| updateComputations1to2 | 1.10169558 | 1.09482565..1.10915087 |
| updateComputations1to4 | 1.05590133 | 1.04720926..1.15596649 |
| updateComputations1to1000 | 1.25815683 | 1.17587477..1.39701743 |
| dynamic/dashboard selective reads | 0.99729023 | 0.90909014..1.02794095 |
| dynamic/editor derived state | 1.02412920 | 0.94927499..1.05078741 |
| dynamic/kanban board | 0.89363659 | 0.88623457..0.90485772 |
| dynamic/entity detail page | 0.94730550 | 0.91834858..0.96890001 |
| dynamic/layered full-drain cold | 0.96275952 | 0.89758021..0.97095725 |
| dynamic/layered full-drain warm | 0.97348626 | 0.91319483..0.98852768 |
| dynamic/layered burst flush warm | 1.01540062 | 0.93585761..1.01895736 |
| dynamic/stable diamond mesh warm | 0.93899245 | 0.92215076..0.95340115 |
| dynamic/pure pull | 1.08362121 | 1.07096208..1.10953573 |
| dynamic/pure push | 0.94372298 | 0.93363369..0.96418658 |
| dynamic/simple component | 1.04404417 | 0.97451392..1.04986039 |
| dynamic/dynamic component | 0.89062351 | 0.86243911..0.91065353 |
| dynamic/large web app | 0.99565685 | 0.97441223..1.01377388 |
| dynamic/wide dense | 0.81604953 | 0.81031773..0.82468544 |
| dynamic/deep | 0.94994087 | 0.94684068..0.99043446 |
| lifecycle/owned graph create-update-dispose | 0.84620395 | 0.82906639..0.88899334 |
| lifecycle/dispose retained graph | 1.29967377 | 1.27508182..1.32053717 |
| cellx1000 | 0.94132180 | 0.92538067..0.94474801 |
| cellx2500 | 0.98618114 | 0.96719608..1.01525634 |

#### lite-signal-reset/lite-signal-1.6

geomean 0.83184180 (per-row min 0.39746031, max 1.26129783, 51 rows)

| row | lite-signal-reset / lite-signal-1.6 | round range |
|---|---:|---|
| avoidablePropagation | 0.89604031 | 0.80842032..0.99875306 |
| broadPropagation | 0.90912949 | 0.88132181..0.95938107 |
| deepPropagation | 0.95009980 | 0.94942914..0.96746586 |
| diamond | 0.93511888 | 0.91978545..0.94602246 |
| mux | 0.99552738 | 0.96774014..1.04848606 |
| repeatedObservers | 0.86971850 | 0.86037920..0.87173678 |
| triangle | 0.93954902 | 0.93548057..0.94947207 |
| unstable | 0.84147610 | 0.82708951..0.85117902 |
| manyEffectsFromOneSource | 0.74398122 | 0.73625185..0.77438009 |
| manySourcesIntoOneComputedEffectWithDirect | 1.05254830 | 0.98375380..1.06294621 |
| manySourcesIntoOneComputedEffect | 1.05023499 | 1.01905560..1.07136650 |
| manySourcesIntoOneDirectEffect | 0.95937818 | 0.94875636..0.96262364 |
| molBench | 1.03916909 | 0.96761111..1.10027921 |
| mutable-object/immutable replacement | 0.95134653 | 0.94534086..0.98958722 |
| mutable-object/in-place versioned | 0.88049877 | 0.87555978..0.88944051 |
| createDataSignals | 0.39746031 | 0.38003333..0.42418343 |
| createComputations0to1 | 0.40724541 | 0.40152846..0.42781396 |
| createComputations1to1 | 0.45111495 | 0.43408552..0.45309066 |
| createComputations2to1 | 0.66020113 | 0.64730367..0.66975091 |
| createComputations4to1 | 0.57491271 | 0.55790962..0.57671934 |
| createComputations1000to1 | 0.40328842 | 0.39053742..0.42555817 |
| createComputations1to2 | 0.46806942 | 0.46501411..0.50123197 |
| createComputations1to4 | 0.46895221 | 0.45403621..0.47955085 |
| createComputations1to8 | 0.44082412 | 0.43757408..0.45368097 |
| createComputations1to1000 | 0.43360111 | 0.42541644..0.44113621 |
| updateComputations1to1 | 0.85219677 | 0.84884181..0.85596502 |
| updateComputations2to1 | 0.87475611 | 0.87096625..0.87524074 |
| updateComputations4to1 | 0.96100787 | 0.91504097..0.99701650 |
| updateComputations1000to1 | 1.00962878 | 0.95014916..1.08065476 |
| updateComputations1to2 | 0.87120239 | 0.86228638..0.88382691 |
| updateComputations1to4 | 0.89413247 | 0.88947036..0.94242468 |
| updateComputations1to1000 | 0.90876077 | 0.90512141..0.91594519 |
| dynamic/dashboard selective reads | 1.01500467 | 0.98197167..1.02912202 |
| dynamic/editor derived state | 1.06355590 | 1.02709340..1.07228589 |
| dynamic/kanban board | 1.03329703 | 1.02366794..1.04661881 |
| dynamic/entity detail page | 1.06888946 | 1.01707603..1.12377167 |
| dynamic/layered full-drain cold | 1.21936768 | 1.17667826..1.33906101 |
| dynamic/layered full-drain warm | 1.00878494 | 0.99345565..1.10986406 |
| dynamic/layered burst flush warm | 1.00067018 | 0.95540673..1.13369877 |
| dynamic/stable diamond mesh warm | 0.98778664 | 0.97560507..1.00274722 |
| dynamic/pure pull | 0.83634034 | 0.82969343..0.85076007 |
| dynamic/pure push | 1.05497395 | 1.02190665..1.10307957 |
| dynamic/simple component | 0.95788391 | 0.94574224..0.97182424 |
| dynamic/dynamic component | 1.04120014 | 1.03717579..1.04530134 |
| dynamic/large web app | 1.09341509 | 1.08726587..1.09674429 |
| dynamic/wide dense | 1.26129783 | 1.24939710..1.31285158 |
| dynamic/deep | 1.08999400 | 1.08075639..1.13959691 |
| lifecycle/owned graph create-update-dispose | 0.77839508 | 0.76898794..0.78382646 |
| lifecycle/dispose retained graph | 0.98622881 | 0.98265876..0.99270939 |
| cellx1000 | 0.86711660 | 0.84673967..0.87733748 |
| cellx2500 | 0.80134903 | 0.79218447..0.83432466 |

#### lite-signal-eager-reset/lite-signal-eager-1.6

geomean 0.89044618 (per-row min 0.46215063, max 1.86200004, 51 rows)

| row | lite-signal-eager-reset / lite-signal-eager-1.6 | round range |
|---|---:|---|
| avoidablePropagation | 0.77241205 | 0.68291048..0.84645243 |
| broadPropagation | 0.90569943 | 0.80946219..0.96014667 |
| deepPropagation | 1.39679852 | 1.02788048..1.48409854 |
| diamond | 0.60879367 | 0.52776880..0.62639473 |
| mux | 1.04798022 | 0.94432398..1.06665593 |
| repeatedObservers | 0.82091918 | 0.72014544..0.83198935 |
| triangle | 0.60612642 | 0.51531994..0.80746373 |
| unstable | 0.52575646 | 0.50934039..0.53813768 |
| manyEffectsFromOneSource | 0.68568047 | 0.61176915..1.03819604 |
| manySourcesIntoOneComputedEffectWithDirect | 1.74104088 | 0.72542513..1.85053104 |
| manySourcesIntoOneComputedEffect | 1.86200004 | 0.98882825..1.96640500 |
| manySourcesIntoOneDirectEffect | 0.91336833 | 0.89876892..0.93062603 |
| molBench | 0.97672664 | 0.89377269..1.01171908 |
| mutable-object/immutable replacement | 0.67306038 | 0.65587432..0.69604015 |
| mutable-object/in-place versioned | 0.65297109 | 0.63018593..0.67683386 |
| createDataSignals | 0.91983673 | 0.90716285..0.93381768 |
| createComputations0to1 | 0.96691965 | 0.95674803..0.98720790 |
| createComputations1to1 | 0.90631583 | 0.87694459..0.92097498 |
| createComputations2to1 | 0.79854787 | 0.78654077..0.82070256 |
| createComputations4to1 | 0.77314451 | 0.74877780..0.81558275 |
| createComputations1000to1 | 0.46215063 | 0.44887165..0.47321815 |
| createComputations1to2 | 0.96055161 | 0.93758517..0.98417818 |
| createComputations1to4 | 0.92382881 | 0.89197391..0.99623628 |
| createComputations1to8 | 0.96988735 | 0.95827131..0.99872557 |
| createComputations1to1000 | 0.91753194 | 0.89140243..0.96805606 |
| updateComputations1to1 | 0.82957851 | 0.82088300..0.83750829 |
| updateComputations2to1 | 0.85453874 | 0.84626660..0.85969788 |
| updateComputations4to1 | 0.90880572 | 0.88727607..0.93126418 |
| updateComputations1000to1 | 1.10714403 | 0.98713691..1.26951703 |
| updateComputations1to2 | 0.84743332 | 0.82974748..0.86318514 |
| updateComputations1to4 | 0.83261759 | 0.80477094..0.86486206 |
| updateComputations1to1000 | 0.91034042 | 0.73804669..1.00651942 |
| dynamic/dashboard selective reads | 0.95570783 | 0.84180219..1.05685682 |
| dynamic/editor derived state | 1.03763935 | 1.00672086..1.12296258 |
| dynamic/kanban board | 0.99781904 | 0.98391359..1.00802242 |
| dynamic/entity detail page | 1.00266775 | 0.96667293..1.03118235 |
| dynamic/layered full-drain cold | 1.21767929 | 1.18562110..1.25934084 |
| dynamic/layered full-drain warm | 1.01217355 | 0.99736261..1.03758694 |
| dynamic/layered burst flush warm | 0.92942689 | 0.91029360..1.00323740 |
| dynamic/stable diamond mesh warm | 1.02680248 | 1.00294471..1.05739197 |
| dynamic/pure pull | 0.51750520 | 0.49095606..0.55143483 |
| dynamic/pure push | 1.01554975 | 0.99817372..1.05094351 |
| dynamic/simple component | 1.01943130 | 0.86884431..1.10607374 |
| dynamic/dynamic component | 1.12834334 | 0.89115818..1.17620945 |
| dynamic/large web app | 0.97008414 | 0.95902233..0.99084880 |
| dynamic/wide dense | 1.10334207 | 1.09147157..1.11079239 |
| dynamic/deep | 0.94197374 | 0.90145413..0.95616384 |
| lifecycle/owned graph create-update-dispose | 0.58731478 | 0.57876449..0.61491475 |
| lifecycle/dispose retained graph | 0.82019817 | 0.76150974..0.84940479 |
| cellx1000 | 0.80353775 | 0.79346770..0.82047077 |
| cellx2500 | 0.82648654 | 0.79097379..0.83766940 |

### Void rows (excluded)

none

### Capped rows (listed, not ranked)

none

## Leg leg-node24

- node v24.15.0, v8 13.6.233.17-node.48, darwin/arm64, cpu Apple M4 Pro
- bundleSha256 0ab7cb36431b6d87885680ee10cfbc7f5a18af630c7c3e05e206892ab4cea647, sourceCommit 12f169b0f7d25de343433e3199c27d0472136185, rounds 3, profile quick
- packages: lite-signal=1.5.2, lite-signal-eager=1.5.2, lite-signal-1.6=1.6.0-candidate+6bcaaf1.a7202c9b, lite-signal-eager-1.6=1.6.0-candidate+6bcaaf1.a7202c9b, lite-signal-reset=1.6.0-candidate+6bcaaf1.a7202c9b, lite-signal-eager-reset=1.6.0-candidate+6bcaaf1.a7202c9b, alien-signals=3.2.1
- rows: total 51, ranked 51, void 0, capped 0
- records per adapter: lite-signal=51, lite-signal-eager=51, lite-signal-1.6=51, lite-signal-eager-1.6=51, lite-signal-reset=51, lite-signal-eager-reset=51, alien-signals=51

### LAZY

| rank | adapter | geomean / alien | geomean / best (upstream style) | row wins |
|---:|---|---:|---:|---:|
| 1 | alien-signals | 1.00000000 | 1.04338429 | 42 |
| 2 | lite-signal-reset | 1.27392660 | 1.32919500 | 5 |
| 3 | lite-signal-1.6 | 1.43231762 | 1.49445772 | 4 |
| 4 | lite-signal | 1.46296882 | 1.52643869 | 0 |

### EAGER

| rank | adapter | geomean / alien | geomean / best (upstream style) | row wins |
|---:|---|---:|---:|---:|
| 1 | alien-signals | 1.00000000 | 1.03444333 | 43 |
| 2 | lite-signal-eager-reset | 1.33437263 | 1.38033287 | 6 |
| 3 | lite-signal-eager | 1.50764427 | 1.55957256 | 1 |
| 4 | lite-signal-eager-1.6 | 1.62179391 | 1.67765389 | 1 |

### OVERALL (all 7 adapters)

| rank | adapter | geomean / alien | geomean / best (upstream style) | row wins |
|---:|---|---:|---:|---:|
| 1 | alien-signals | 1.00000000 | 1.04424423 | 42 |
| 2 | lite-signal-reset | 1.27392660 | 1.33029050 | 3 |
| 3 | lite-signal-eager-reset | 1.33437263 | 1.39341092 | 2 |
| 4 | lite-signal-1.6 | 1.43231762 | 1.49568942 | 3 |
| 5 | lite-signal | 1.46296882 | 1.52769675 | 0 |
| 6 | lite-signal-eager | 1.50764427 | 1.57434883 | 0 |
| 7 | lite-signal-eager-1.6 | 1.62179391 | 1.69354894 | 1 |

### 1.6 vs 1.5.2 and reset vs 1.6 destroy (per row, round range)

#### lite-signal-1.6/lite-signal

geomean 0.97904864 (per-row min 0.78959590, max 1.40855467, 51 rows)

| row | lite-signal-1.6 / lite-signal | round range |
|---|---:|---|
| avoidablePropagation | 1.03308920 | 1.00782619..1.04450271 |
| broadPropagation | 0.97604836 | 0.95713043..0.97977730 |
| deepPropagation | 0.97462124 | 0.96813815..0.97895885 |
| diamond | 1.00714268 | 0.98718269..1.01291809 |
| mux | 0.95213222 | 0.92125728..0.98929659 |
| repeatedObservers | 0.98446376 | 0.97967264..0.99159712 |
| triangle | 0.92182345 | 0.89637007..0.93273765 |
| unstable | 0.91023431 | 0.88369161..0.91934862 |
| manyEffectsFromOneSource | 0.90486195 | 0.88883537..0.91617536 |
| manySourcesIntoOneComputedEffectWithDirect | 0.90697390 | 0.88671028..0.91625656 |
| manySourcesIntoOneComputedEffect | 0.91158990 | 0.89135458..0.91952602 |
| manySourcesIntoOneDirectEffect | 1.02342298 | 1.01807688..1.02882598 |
| molBench | 0.91867972 | 0.89630417..1.00464882 |
| mutable-object/immutable replacement | 1.00366169 | 0.99572540..1.01084689 |
| mutable-object/in-place versioned | 1.01176228 | 1.00212875..1.02993186 |
| createDataSignals | 1.40855467 | 1.40257598..1.41483065 |
| createComputations0to1 | 1.17518328 | 1.17197583..1.23743839 |
| createComputations1to1 | 1.06059468 | 1.02456225..1.07654039 |
| createComputations2to1 | 1.01705795 | 1.00310059..1.02474606 |
| createComputations4to1 | 0.99813151 | 0.99607746..1.00056041 |
| createComputations1000to1 | 1.02246557 | 1.01395850..1.02573162 |
| createComputations1to2 | 1.09144259 | 1.08130624..1.11019179 |
| createComputations1to4 | 0.99614325 | 0.99360583..1.01001685 |
| createComputations1to8 | 1.07920486 | 1.03661475..1.08485835 |
| createComputations1to1000 | 0.78959590 | 0.76998281..0.85355524 |
| updateComputations1to1 | 1.05625243 | 1.04886013..1.05718337 |
| updateComputations2to1 | 1.03762963 | 1.01643590..1.04570721 |
| updateComputations4to1 | 1.03767142 | 1.01039492..1.05226642 |
| updateComputations1000to1 | 0.96588824 | 0.95656073..0.98907522 |
| updateComputations1to2 | 1.07422576 | 1.06486025..1.07889407 |
| updateComputations1to4 | 1.05873653 | 1.05592612..1.06352675 |
| updateComputations1to1000 | 1.05869247 | 1.05663572..1.06774921 |
| dynamic/dashboard selective reads | 0.87141986 | 0.85877159..0.88514584 |
| dynamic/editor derived state | 0.89592273 | 0.88046357..0.89832580 |
| dynamic/kanban board | 0.86982984 | 0.86397119..0.88580271 |
| dynamic/entity detail page | 0.86977039 | 0.86713544..0.88850818 |
| dynamic/layered full-drain cold | 0.99047825 | 0.92539196..1.13744697 |
| dynamic/layered full-drain warm | 1.10704224 | 0.92798202..1.17478769 |
| dynamic/layered burst flush warm | 0.98800476 | 0.92057337..1.01933995 |
| dynamic/stable diamond mesh warm | 0.93276659 | 0.92732236..0.95902579 |
| dynamic/pure pull | 1.00476176 | 0.99844613..1.01032469 |
| dynamic/pure push | 0.86475703 | 0.85751301..0.88589540 |
| dynamic/simple component | 0.97655790 | 0.96804905..0.97988854 |
| dynamic/dynamic component | 0.80976133 | 0.79467217..0.82629393 |
| dynamic/large web app | 0.94850255 | 0.94386163..0.95730942 |
| dynamic/wide dense | 0.82853674 | 0.79638151..0.83391734 |
| dynamic/deep | 0.86405749 | 0.85037042..0.87559400 |
| lifecycle/owned graph create-update-dispose | 1.02725808 | 1.01855281..1.03489468 |
| lifecycle/dispose retained graph | 1.13105112 | 1.10976594..1.14571795 |
| cellx1000 | 0.91325987 | 0.87695471..0.93251982 |
| cellx2500 | 0.92574209 | 0.91867585..0.93329654 |

#### lite-signal-eager-1.6/lite-signal-eager

geomean 1.07571391 (per-row min 0.83856499, max 1.74851574, 51 rows)

| row | lite-signal-eager-1.6 / lite-signal-eager | round range |
|---|---:|---|
| avoidablePropagation | 1.07898426 | 1.04574987..1.10371852 |
| broadPropagation | 1.31946096 | 1.28671775..1.38678092 |
| deepPropagation | 1.42148014 | 1.30669852..1.44818961 |
| diamond | 1.12944706 | 1.11034958..1.14046983 |
| mux | 1.17627168 | 1.13355453..1.20619524 |
| repeatedObservers | 0.99709599 | 0.98332827..1.00527552 |
| triangle | 1.26562500 | 1.23607250..1.28082424 |
| unstable | 1.14257406 | 1.13249099..1.18663092 |
| manyEffectsFromOneSource | 1.21828958 | 1.19974167..1.23994997 |
| manySourcesIntoOneComputedEffectWithDirect | 1.68573022 | 1.65378303..1.69094095 |
| manySourcesIntoOneComputedEffect | 1.74851574 | 1.71471749..1.75555685 |
| manySourcesIntoOneDirectEffect | 1.03292103 | 1.01000320..1.04376445 |
| molBench | 1.03342919 | 0.95653875..1.10504649 |
| mutable-object/immutable replacement | 1.09318348 | 1.06767196..1.13234194 |
| mutable-object/in-place versioned | 1.13002715 | 1.10010290..1.14662919 |
| createDataSignals | 0.99921205 | 0.99109699..1.03432214 |
| createComputations0to1 | 1.02871959 | 1.02030185..1.03333183 |
| createComputations1to1 | 1.00536285 | 0.99078404..1.03407431 |
| createComputations2to1 | 1.03557991 | 1.01907444..1.05409184 |
| createComputations4to1 | 1.02824526 | 1.01585636..1.03963880 |
| createComputations1000to1 | 0.98863023 | 0.97512859..1.02880515 |
| createComputations1to2 | 1.01913524 | 0.99964875..1.02932098 |
| createComputations1to4 | 0.97823751 | 0.97126849..0.99431646 |
| createComputations1to8 | 1.00757485 | 0.99816859..1.03224335 |
| createComputations1to1000 | 1.04077735 | 1.03037415..1.04929592 |
| updateComputations1to1 | 1.03591451 | 1.03531313..1.07785415 |
| updateComputations2to1 | 1.04898206 | 1.03416290..1.06726892 |
| updateComputations4to1 | 1.04602889 | 1.04122385..1.06848883 |
| updateComputations1000to1 | 1.55181494 | 1.51140555..1.56782258 |
| updateComputations1to2 | 1.05758457 | 1.04882346..1.06714274 |
| updateComputations1to4 | 1.06518092 | 1.01764407..1.10292160 |
| updateComputations1to1000 | 1.29309186 | 1.23507237..1.38380776 |
| dynamic/dashboard selective reads | 1.02028754 | 1.00151086..1.04023015 |
| dynamic/editor derived state | 1.00442455 | 0.98051061..1.12967011 |
| dynamic/kanban board | 0.89597519 | 0.88540327..0.92679938 |
| dynamic/entity detail page | 0.90853396 | 0.88887134..0.92803906 |
| dynamic/layered full-drain cold | 1.02731974 | 1.00378801..1.05874002 |
| dynamic/layered full-drain warm | 1.02788462 | 1.00696395..1.04597946 |
| dynamic/layered burst flush warm | 0.98345585 | 0.96424404..1.01235322 |
| dynamic/stable diamond mesh warm | 0.97232646 | 0.95389067..0.98909087 |
| dynamic/pure pull | 1.05351669 | 1.04834906..1.10070676 |
| dynamic/pure push | 0.94350548 | 0.90873816..0.94882930 |
| dynamic/simple component | 1.06478284 | 0.97699995..1.08726436 |
| dynamic/dynamic component | 0.97786570 | 0.88602883..1.03420508 |
| dynamic/large web app | 0.95086673 | 0.94452696..0.96209872 |
| dynamic/wide dense | 0.83856499 | 0.83189487..0.84902509 |
| dynamic/deep | 0.94271697 | 0.92915265..0.95007845 |
| lifecycle/owned graph create-update-dispose | 1.11104915 | 1.03985982..1.17395114 |
| lifecycle/dispose retained graph | 1.21325983 | 1.20106998..1.23969524 |
| cellx1000 | 0.93228259 | 0.92250618..0.97308263 |
| cellx2500 | 0.93606664 | 0.91993106..0.94249437 |

#### lite-signal-reset/lite-signal-1.6

geomean 0.88941627 (per-row min 0.59681953, max 1.25180201, 51 rows)

| row | lite-signal-reset / lite-signal-1.6 | round range |
|---|---:|---|
| avoidablePropagation | 0.91066782 | 0.90539134..0.92153947 |
| broadPropagation | 0.94701940 | 0.92654014..0.96445907 |
| deepPropagation | 0.98012074 | 0.94538187..0.98936993 |
| diamond | 0.94183371 | 0.93012880..0.95352450 |
| mux | 0.99339249 | 0.96397922..1.01858261 |
| repeatedObservers | 0.81480510 | 0.80654710..0.82060856 |
| triangle | 0.93092684 | 0.91752717..0.95757235 |
| unstable | 0.83843613 | 0.82202197..0.84881683 |
| manyEffectsFromOneSource | 0.75318240 | 0.74641049..0.76599058 |
| manySourcesIntoOneComputedEffectWithDirect | 1.00239916 | 0.99163477..1.02540783 |
| manySourcesIntoOneComputedEffect | 1.03261949 | 1.02457425..1.04436822 |
| manySourcesIntoOneDirectEffect | 0.97645835 | 0.96645078..0.97960503 |
| molBench | 1.00943557 | 0.99186040..1.03735940 |
| mutable-object/immutable replacement | 0.94058572 | 0.92585060..0.97466262 |
| mutable-object/in-place versioned | 0.87864736 | 0.86257249..0.88825010 |
| createDataSignals | 0.64230321 | 0.64017445..0.64387084 |
| createComputations0to1 | 0.79699892 | 0.76312057..0.82011282 |
| createComputations1to1 | 0.70516009 | 0.70080975..0.72300173 |
| createComputations2to1 | 0.67029248 | 0.66287585..0.67686848 |
| createComputations4to1 | 0.60598062 | 0.60431892..0.60782051 |
| createComputations1000to1 | 0.59681953 | 0.59080367..0.60338656 |
| createComputations1to2 | 0.70738404 | 0.70202402..0.71591446 |
| createComputations1to4 | 0.73964948 | 0.71097367..0.74810429 |
| createComputations1to8 | 0.70844764 | 0.70386210..0.71256037 |
| createComputations1to1000 | 0.60395595 | 0.56479335..0.61738178 |
| updateComputations1to1 | 0.85483451 | 0.85248693..0.86098307 |
| updateComputations2to1 | 0.87583563 | 0.87094354..0.88660454 |
| updateComputations4to1 | 0.93681907 | 0.92021893..0.95924612 |
| updateComputations1000to1 | 0.96670216 | 0.94860642..0.97472159 |
| updateComputations1to2 | 0.88079446 | 0.87440112..0.89045323 |
| updateComputations1to4 | 0.90584324 | 0.89447838..0.91806234 |
| updateComputations1to1000 | 0.90192312 | 0.88198844..0.91747386 |
| dynamic/dashboard selective reads | 0.98981457 | 0.97553940..1.01263932 |
| dynamic/editor derived state | 1.00283361 | 0.98861180..1.01506468 |
| dynamic/kanban board | 1.04715626 | 1.03210044..1.06133701 |
| dynamic/entity detail page | 1.10591184 | 1.05773570..1.13875048 |
| dynamic/layered full-drain cold | 1.19168513 | 1.02801851..1.41376052 |
| dynamic/layered full-drain warm | 0.88213927 | 0.85703109..1.04250387 |
| dynamic/layered burst flush warm | 0.97811524 | 0.93634571..0.99765877 |
| dynamic/stable diamond mesh warm | 1.00744724 | 0.97922696..1.00991543 |
| dynamic/pure pull | 0.81511990 | 0.79964177..0.82102727 |
| dynamic/pure push | 1.05448765 | 1.00616844..1.06442721 |
| dynamic/simple component | 0.93955330 | 0.93598099..0.96471183 |
| dynamic/dynamic component | 1.03926096 | 1.01322195..1.04822850 |
| dynamic/large web app | 1.10338380 | 1.08747508..1.10903390 |
| dynamic/wide dense | 1.25180201 | 1.20499946..1.27719293 |
| dynamic/deep | 1.12592222 | 1.10278136..1.18698063 |
| lifecycle/owned graph create-update-dispose | 0.76633531 | 0.76386770..0.78178765 |
| lifecycle/dispose retained graph | 0.99523810 | 0.96839810..1.00478469 |
| cellx1000 | 0.88141767 | 0.86515352..0.88531134 |
| cellx2500 | 0.79537168 | 0.78430769..0.80557126 |

#### lite-signal-eager-reset/lite-signal-eager-1.6

geomean 0.82277571 (per-row min 0.48359212, max 1.48353283, 51 rows)

| row | lite-signal-eager-reset / lite-signal-eager-1.6 | round range |
|---|---:|---|
| avoidablePropagation | 0.76616259 | 0.73380210..0.78372263 |
| broadPropagation | 0.94050903 | 0.59806323..0.96534392 |
| deepPropagation | 0.59047619 | 0.52182211..1.06843638 |
| diamond | 0.58013814 | 0.57832297..0.59969456 |
| mux | 0.74447527 | 0.70757194..0.77383413 |
| repeatedObservers | 0.74444460 | 0.71254443..0.75379649 |
| triangle | 0.58562583 | 0.55426962..0.79000742 |
| unstable | 0.52167881 | 0.50606310..0.54044668 |
| manyEffectsFromOneSource | 0.85689682 | 0.54989822..0.92254385 |
| manySourcesIntoOneComputedEffectWithDirect | 1.48353283 | 1.46613558..1.52552868 |
| manySourcesIntoOneComputedEffect | 0.51532595 | 0.51095714..0.53483013 |
| manySourcesIntoOneDirectEffect | 0.94541892 | 0.93307583..0.98718499 |
| molBench | 0.96430769 | 0.87006767..1.07044481 |
| mutable-object/immutable replacement | 0.70516801 | 0.65014476..0.72161528 |
| mutable-object/in-place versioned | 0.63336165 | 0.61719978..0.67277313 |
| createDataSignals | 0.88748343 | 0.87086992..0.89539762 |
| createComputations0to1 | 0.82136315 | 0.81787675..0.85006179 |
| createComputations1to1 | 0.84181144 | 0.82670400..0.85757154 |
| createComputations2to1 | 0.79955351 | 0.79219518..0.83447768 |
| createComputations4to1 | 0.77650248 | 0.76635356..0.78698143 |
| createComputations1000to1 | 0.62141368 | 0.60340124..0.64414507 |
| createComputations1to2 | 0.84533301 | 0.83767542..0.85931473 |
| createComputations1to4 | 0.87686707 | 0.86644004..0.88802494 |
| createComputations1to8 | 0.83759695 | 0.81898235..0.84512855 |
| createComputations1to1000 | 0.87984802 | 0.87381844..0.89518376 |
| updateComputations1to1 | 0.85933028 | 0.83898408..0.86317888 |
| updateComputations2to1 | 0.84943133 | 0.83868584..0.85778422 |
| updateComputations4to1 | 0.85667319 | 0.84495640..0.86277917 |
| updateComputations1000to1 | 0.61636038 | 0.60063165..0.91027419 |
| updateComputations1to2 | 0.86460518 | 0.85371998..0.88462712 |
| updateComputations1to4 | 0.86850934 | 0.84794941..0.88844358 |
| updateComputations1to1000 | 0.77375956 | 0.66247971..0.80450585 |
| dynamic/dashboard selective reads | 0.83911793 | 0.82346815..0.98673955 |
| dynamic/editor derived state | 0.87437676 | 0.77372191..0.90266550 |
| dynamic/kanban board | 0.97859978 | 0.94523062..1.00199909 |
| dynamic/entity detail page | 1.05311443 | 1.02523526..1.07157491 |
| dynamic/layered full-drain cold | 1.21666761 | 1.15632673..1.23796459 |
| dynamic/layered full-drain warm | 1.03089323 | 0.98224743..1.04464207 |
| dynamic/layered burst flush warm | 0.97995534 | 0.95842830..0.98163718 |
| dynamic/stable diamond mesh warm | 1.05426805 | 1.03331750..1.06384236 |
| dynamic/pure pull | 0.48359212 | 0.47899271..0.52809385 |
| dynamic/pure push | 0.91029401 | 0.90316332..1.04269344 |
| dynamic/simple component | 0.98161931 | 0.81440132..1.09870347 |
| dynamic/dynamic component | 0.80048207 | 0.76455979..1.08097550 |
| dynamic/large web app | 1.01622237 | 0.99995456..1.02671925 |
| dynamic/wide dense | 1.11381215 | 1.10119025..1.12346805 |
| dynamic/deep | 0.96421754 | 0.96033825..0.98137062 |
| lifecycle/owned graph create-update-dispose | 0.68670101 | 0.65912339..0.70037419 |
| lifecycle/dispose retained graph | 0.79718118 | 0.74071969..0.84945801 |
| cellx1000 | 0.82125782 | 0.78301988..0.83228904 |
| cellx2500 | 0.89009300 | 0.87995620..0.89748412 |

### Void rows (excluded)

none

### Capped rows (listed, not ranked)

none

## Rank agreement leg-node26 (v26.8.2) vs leg-node24 (v24.15.0)

bundleSha256 0ab7cb36431b6d87885680ee10cfbc7f5a18af630c7c3e05e206892ab4cea647 (identical); rows ranked in both legs: 51

| group | identical | spearman | max abs rank delta | order v26.8.2 | order v24.15.0 |
|---|---|---:|---:|---|---|
| LAZY | yes | 1.00000000 | 0 | alien-signals > lite-signal-reset > lite-signal-1.6 > lite-signal | alien-signals > lite-signal-reset > lite-signal-1.6 > lite-signal |
| EAGER | yes | 1.00000000 | 0 | alien-signals > lite-signal-eager-reset > lite-signal-eager > lite-signal-eager-1.6 | alien-signals > lite-signal-eager-reset > lite-signal-eager > lite-signal-eager-1.6 |
| OVERALL | NO | 0.82142857 | 2 | alien-signals > lite-signal-reset > lite-signal-eager-reset > lite-signal-eager > lite-signal-1.6 > lite-signal-eager-1.6 > lite-signal | alien-signals > lite-signal-reset > lite-signal-eager-reset > lite-signal-1.6 > lite-signal > lite-signal-eager > lite-signal-eager-1.6 |
