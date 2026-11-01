# Stage 1F backtest report (generated)

Evaluation set: 1460 transactions ({'stage1d_transactions_holdout_seed20261102': 492, 'stage1d_transactions_holdout_datedisjoint_seed20261103': 488, 'stage1d_transactions_holdout_datedisjoint_v2_seed20261104': 480}); 2 test-split duplicates excluded, 38 exact-duplicate rows (within or across holdouts) removed.

## Overall (mean +/- SD across checkpoints; deterministic baselines have SD 0)

| scenario | policy | completion | unrouted share | reward (env) | reward (amount) | cost | latency | utilization | bridges | ms/decision |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | cheapest_feasible | 0.3829 | 0.3068 | 0.5891 ± 0.0000 | 0.5891 | 1.7257 | 0.9264 | 0.6932 | 1.00 | 0.008 |
| baseline | liquidity_waterfall | 0.9966 | 0.0002 | 0.9595 ± 0.0000 | 0.9594 | 2.1550 | 1.1955 | 0.9998 | 1.63 | 3.440 |
| baseline | ppo_original | 0.9509 | 0.0056 | 0.9577 ± 0.0021 | 0.9577 | 2.1465 | 1.1853 | 0.9944 | 3.00 | 0.891 |
| baseline | ppo_projected | 0.9966 | 0.0002 | 0.9613 ± 0.0031 | 0.9611 | 2.1518 | 1.1905 | 0.9998 | 3.00 | 1.179 |
| cheapest_venue_outage | cheapest_feasible | 0.0123 | 0.9210 | -0.7532 ± 0.0000 | -0.7532 | 0.2734 | 0.1542 | 0.0790 | 1.00 | 0.008 |
| cheapest_venue_outage | liquidity_waterfall | 0.9651 | 0.0051 | 0.9541 ± 0.0000 | 0.9510 | 2.1464 | 1.1922 | 0.9949 | 2.07 | 4.584 |
| cheapest_venue_outage | ppo_original | 0.1555 | 0.1480 | 0.7152 ± 0.1403 | 0.7152 | 1.8875 | 1.0482 | 0.8520 | 3.00 | 0.695 |
| cheapest_venue_outage | ppo_projected | 0.9651 | 0.0051 | 0.9587 ± 0.0039 | 0.9556 | 2.1454 | 1.1867 | 0.9949 | 3.00 | 0.944 |
| combined_stress | cheapest_feasible | 0.1726 | 0.4874 | -0.1193 ± 0.0000 | -0.1193 | 1.3595 | 1.1027 | 0.5126 | 1.00 | 0.008 |
| combined_stress | liquidity_waterfall | 0.9240 | 0.0162 | 0.3662 ± 0.0000 | 0.3561 | 2.1361 | 1.7699 | 0.9838 | 1.93 | 4.261 |
| combined_stress | ppo_original | 0.8759 | 0.0372 | 0.3617 ± 0.0038 | 0.3617 | 2.1124 | 1.7271 | 0.9628 | 3.00 | 0.691 |
| combined_stress | ppo_projected | 0.9240 | 0.0162 | 0.3671 ± 0.0048 | 0.3571 | 2.1338 | 1.7666 | 0.9838 | 3.00 | 0.935 |
| congestion_x2 | cheapest_feasible | 0.3829 | 0.3068 | -0.3373 ± 0.0000 | -0.3373 | 1.7257 | 1.8528 | 0.6932 | 1.00 | 0.008 |
| congestion_x2 | liquidity_waterfall | 0.9966 | 0.0002 | -0.2360 ± 0.0000 | -0.2361 | 2.1550 | 2.3910 | 0.9998 | 1.63 | 3.359 |
| congestion_x2 | ppo_original | 0.9436 | 0.0075 | -0.2290 ± 0.0068 | -0.2290 | 2.1446 | 2.3689 | 0.9925 | 3.00 | 0.702 |
| congestion_x2 | ppo_projected | 0.9966 | 0.0002 | -0.2337 ± 0.0089 | -0.2338 | 2.1518 | 2.3855 | 0.9998 | 3.00 | 0.962 |
| liquidity_minus30 | cheapest_feasible | 0.1726 | 0.4874 | 0.2482 ± 0.0000 | 0.2482 | 1.3595 | 0.7351 | 0.5126 | 1.00 | 0.007 |
| liquidity_minus30 | liquidity_waterfall | 0.9240 | 0.0162 | 0.9561 ± 0.0000 | 0.9461 | 2.1361 | 1.1800 | 0.9838 | 1.93 | 3.822 |
| liquidity_minus30 | ppo_original | 0.8774 | 0.0356 | 0.9376 ± 0.0060 | 0.9376 | 2.1140 | 1.1538 | 0.9644 | 3.00 | 0.945 |
| liquidity_minus30 | ppo_projected | 0.9240 | 0.0162 | 0.9563 ± 0.0030 | 0.9462 | 2.1338 | 1.1775 | 0.9838 | 3.00 | 1.206 |
| liquidity_minus50 | cheapest_feasible | 0.1226 | 0.6236 | -0.0330 ± 0.0000 | -0.0330 | 1.0584 | 0.5778 | 0.3764 | 1.00 | 0.007 |
| liquidity_minus50 | liquidity_waterfall | 0.8808 | 0.0575 | 0.9581 ± 0.0000 | 0.9217 | 2.0907 | 1.1327 | 0.9425 | 2.03 | 3.900 |
| liquidity_minus50 | ppo_original | 0.7764 | 0.0861 | 0.8981 ± 0.0137 | 0.8981 | 2.0556 | 1.1018 | 0.9139 | 3.00 | 18.721 |
| liquidity_minus50 | ppo_projected | 0.8808 | 0.0575 | 0.9587 ± 0.0021 | 0.9223 | 2.0891 | 1.1303 | 0.9425 | 3.00 | 18.953 |

## Paired comparisons (estimate, 95% two-level cluster-bootstrap CI, Holm-adjusted p)

| scenario | test | metric | estimate | 95% CI | p (Holm) | checkpoints +/- | equivalence |
|---|---|---|---|---|---|---|---|
| baseline | H1 | reward | +0.00174 | [-0.01311, +0.01621] | 1.0000 | 4/2 | inconclusive |
| baseline | H2 | completed | +0.04566 | [+0.02506, +0.06914] | 0.0000 | 6/0 | positive |
| baseline | H3 | reward | -0.00189 | [-0.01632, +0.01231] | 1.0000 | 0/6 | inconclusive |
| baseline | H4 | completed | +0.00000 | [+0.00000, +0.00000] | 1.0000 | 0/0 | practically_negligible |
| baseline__stress_family | projected_vs_waterfall_reward_amount | reward_amount | +0.00174 | [-0.01322, +0.01603] | 1.0000 | 4/2 | inconclusive |
| baseline__stress_family | projected_vs_waterfall_completion | completed | +0.00000 | [+0.00000, +0.00000] | 1.0000 | 0/0 | practically_negligible |
| baseline__stress_family | projected_vs_original_completion | completed | +0.04566 | [+0.02448, +0.06834] | 0.0000 | 6/0 | positive |
| baseline__stress_family | original_vs_waterfall_reward_amount | reward_amount | -0.00174 | [-0.01623, +0.01258] | 1.0000 | 0/6 | inconclusive |
| liquidity_minus30__stress_family | projected_vs_waterfall_reward_amount | reward_amount | +0.00012 | [-0.01212, +0.01157] | 1.0000 | 2/4 | inconclusive |
| liquidity_minus30__stress_family | projected_vs_waterfall_completion | completed | +0.00000 | [+0.00000, +0.00000] | 1.0000 | 0/0 | practically_negligible |
| liquidity_minus30__stress_family | projected_vs_original_completion | completed | +0.04658 | [+0.03250, +0.06191] | 0.0000 | 6/0 | positive |
| liquidity_minus30__stress_family | original_vs_waterfall_reward_amount | reward_amount | -0.00845 | [-0.02129, +0.00334] | 0.5550 | 0/6 | inconclusive |
| liquidity_minus50__stress_family | projected_vs_waterfall_reward_amount | reward_amount | +0.00065 | [-0.00841, +0.00956] | 1.0000 | 2/4 | inconclusive |
| liquidity_minus50__stress_family | projected_vs_waterfall_completion | completed | +0.00000 | [+0.00000, +0.00000] | 1.0000 | 0/0 | practically_negligible |
| liquidity_minus50__stress_family | projected_vs_original_completion | completed | +0.10445 | [+0.07275, +0.13561] | 0.0000 | 6/0 | positive |
| liquidity_minus50__stress_family | original_vs_waterfall_reward_amount | reward_amount | -0.02358 | [-0.03956, -0.01122] | 0.0000 | 0/6 | negative |
| cheapest_venue_outage__stress_family | projected_vs_waterfall_reward_amount | reward_amount | +0.00458 | [+0.00054, +0.00917] | 0.0420 | 6/0 | positive |
| cheapest_venue_outage__stress_family | projected_vs_waterfall_completion | completed | +0.00000 | [+0.00000, +0.00000] | 1.0000 | 0/0 | practically_negligible |
| cheapest_venue_outage__stress_family | projected_vs_original_completion | completed | +0.80959 | [+0.69519, +0.88455] | 0.0000 | 6/0 | positive |
| cheapest_venue_outage__stress_family | original_vs_waterfall_reward_amount | reward_amount | -0.23583 | [-0.34168, -0.13701] | 0.0000 | 0/6 | negative |
| congestion_x2__stress_family | projected_vs_waterfall_reward_amount | reward_amount | +0.00225 | [-0.02962, +0.03307] | 1.0000 | 3/3 | inconclusive |
| congestion_x2__stress_family | projected_vs_waterfall_completion | completed | +0.00000 | [+0.00000, +0.00000] | 1.0000 | 0/0 | practically_negligible |
| congestion_x2__stress_family | projected_vs_original_completion | completed | +0.05297 | [+0.03190, +0.07405] | 0.0000 | 6/0 | positive |
| congestion_x2__stress_family | original_vs_waterfall_reward_amount | reward_amount | +0.00715 | [-0.02419, +0.03808] | 1.0000 | 5/1 | inconclusive |
| combined_stress__stress_family | projected_vs_waterfall_reward_amount | reward_amount | +0.00098 | [-0.01775, +0.01827] | 1.0000 | 2/4 | inconclusive |
| combined_stress__stress_family | projected_vs_waterfall_completion | completed | +0.00000 | [+0.00000, +0.00000] | 1.0000 | 0/0 | practically_negligible |
| combined_stress__stress_family | projected_vs_original_completion | completed | +0.04806 | [+0.03428, +0.06309] | 0.0000 | 6/0 | positive |
| combined_stress__stress_family | original_vs_waterfall_reward_amount | reward_amount | +0.00563 | [-0.01225, +0.02369] | 1.0000 | 6/0 | inconclusive |

## Regime breakdown (scenario regime labels; completion / reward-amount, mean across checkpoints)

| scenario | regime | n | ppo_original | ppo_projected | liquidity_waterfall | cheapest_feasible |
|---|---|---|---|---|---|---|
| baseline | below_cheapest | 318 | 1.000 / 0.889 | 1.000 / 0.889 | 1.000 / 0.890 | 1.000 / 0.890 |
| baseline | exceeds_combined | 5 | 0.000 / 0.863 | 0.000 / 1.161 | 0.000 / 1.161 | 0.000 / -0.478 |
| baseline | near_boundary | 489 | 0.999 / 0.980 | 1.000 / 0.980 | 1.000 / 0.980 | 0.493 / 0.909 |
| baseline | splitting_needed | 648 | 0.898 / 0.975 | 1.000 / 0.980 | 1.000 / 0.976 | 0.000 / 0.208 |
| cheapest_venue_outage | below_cheapest | 11 | 1.000 / 0.411 | 1.000 / 0.411 | 1.000 / 0.431 | 1.000 / 0.431 |
| cheapest_venue_outage | exceeds_combined | 51 | 0.000 / 0.070 | 0.000 / 0.294 | 0.000 / 0.294 | 0.000 / -0.964 |
| cheapest_venue_outage | near_boundary | 14 | 1.000 / 0.538 | 1.000 / 0.538 | 1.000 / 0.608 | 0.500 / 0.537 |
| cheapest_venue_outage | splitting_needed | 1384 | 0.146 / 0.743 | 1.000 / 0.988 | 1.000 / 0.983 | 0.000 / -0.768 |
| combined_stress | below_cheapest | 210 | 1.000 / 0.181 | 1.000 / 0.181 | 1.000 / 0.185 | 1.000 / 0.185 |
| combined_stress | exceeds_combined | 111 | 0.000 / -0.928 | 0.000 / -0.958 | 0.000 / -0.958 | 0.000 / -0.981 |
| combined_stress | near_boundary | 84 | 1.000 / 0.492 | 1.000 / 0.492 | 1.000 / 0.511 | 0.500 / 0.458 |
| combined_stress | splitting_needed | 1055 | 0.933 / 0.523 | 1.000 / 0.520 | 1.000 / 0.516 | 0.000 / -0.135 |
| congestion_x2 | below_cheapest | 318 | 1.000 / -0.328 | 1.000 / -0.328 | 1.000 / -0.326 | 1.000 / -0.326 |
| congestion_x2 | exceeds_combined | 5 | 0.000 / 0.402 | 0.000 / 0.641 | 0.000 / 0.641 | 0.000 / -0.687 |
| congestion_x2 | near_boundary | 489 | 0.999 / -0.249 | 1.000 / -0.249 | 1.000 / -0.249 | 0.493 / -0.274 |
| congestion_x2 | splitting_needed | 648 | 0.881 / -0.171 | 1.000 / -0.183 | 1.000 / -0.189 | 0.000 / -0.388 |
| liquidity_minus30 | below_cheapest | 210 | 1.000 / 0.830 | 1.000 / 0.830 | 1.000 / 0.833 | 1.000 / 0.833 |
| liquidity_minus30 | exceeds_combined | 111 | 0.000 / -0.249 | 0.000 / -0.168 | 0.000 / -0.168 | 0.000 / -0.813 |
| liquidity_minus30 | near_boundary | 84 | 1.000 / 1.016 | 1.000 / 1.016 | 1.000 / 1.029 | 0.500 / 0.960 |
| liquidity_minus30 | splitting_needed | 1055 | 0.936 / 1.078 | 1.000 / 1.081 | 1.000 / 1.079 | 0.000 / 0.187 |
| liquidity_minus50 | below_cheapest | 147 | 1.000 / 0.795 | 1.000 / 0.795 | 1.000 / 0.798 | 1.000 / 0.798 |
| liquidity_minus50 | exceeds_combined | 174 | 0.000 / -0.382 | 0.000 / -0.314 | 0.000 / -0.314 | 0.000 / -0.847 |
| liquidity_minus50 | near_boundary | 58 | 1.000 / 0.916 | 1.000 / 0.916 | 1.000 / 0.930 | 0.552 / 0.862 |
| liquidity_minus50 | splitting_needed | 1081 | 0.859 / 1.117 | 1.000 / 1.139 | 1.000 / 1.137 | 0.000 / -0.063 |

## Reward-weight sensitivity (evaluation-time; projected - waterfall, amount-based reward)

| scenario | λ_latency | λ_unrouted | best policy | estimate | 95% CI | equivalence |
|---|---|---|---|---|---|---|
| baseline | 0.5 | 1.0 | liquidity_waterfall | -0.00074 | [-0.00819, +0.00638] | inconclusive |
| baseline | 0.5 | 5.0 | liquidity_waterfall | -0.00074 | [-0.00819, +0.00638] | inconclusive |
| baseline | 0.5 | 10.0 | liquidity_waterfall | -0.00074 | [-0.00819, +0.00638] | inconclusive |
| baseline | 1.0 | 1.0 | ppo_projected | +0.00174 | [-0.01322, +0.01603] | inconclusive |
| baseline | 1.0 | 5.0 | ppo_projected | +0.00174 | [-0.01322, +0.01603] | inconclusive |
| baseline | 1.0 | 10.0 | ppo_projected | +0.00174 | [-0.01322, +0.01603] | inconclusive |
| baseline | 2.0 | 1.0 | ppo_original | +0.00670 | [-0.02326, +0.03535] | inconclusive |
| baseline | 2.0 | 5.0 | ppo_projected | +0.00670 | [-0.02326, +0.03535] | inconclusive |
| baseline | 2.0 | 10.0 | ppo_projected | +0.00670 | [-0.02326, +0.03535] | inconclusive |
| liquidity_minus30 | 0.5 | 1.0 | liquidity_waterfall | -0.00109 | [-0.00723, +0.00462] | inconclusive |
| liquidity_minus30 | 0.5 | 5.0 | liquidity_waterfall | -0.00109 | [-0.00723, +0.00462] | inconclusive |
| liquidity_minus30 | 0.5 | 10.0 | liquidity_waterfall | -0.00109 | [-0.00723, +0.00462] | inconclusive |
| liquidity_minus30 | 1.0 | 1.0 | ppo_projected | +0.00012 | [-0.01212, +0.01157] | inconclusive |
| liquidity_minus30 | 1.0 | 5.0 | ppo_projected | +0.00012 | [-0.01212, +0.01157] | inconclusive |
| liquidity_minus30 | 1.0 | 10.0 | ppo_projected | +0.00012 | [-0.01212, +0.01157] | inconclusive |
| liquidity_minus30 | 2.0 | 1.0 | ppo_original | +0.00255 | [-0.02204, +0.02536] | inconclusive |
| liquidity_minus30 | 2.0 | 5.0 | ppo_projected | +0.00255 | [-0.02204, +0.02536] | inconclusive |
| liquidity_minus30 | 2.0 | 10.0 | ppo_projected | +0.00255 | [-0.02204, +0.02536] | inconclusive |
| liquidity_minus50 | 0.5 | 1.0 | liquidity_waterfall | -0.00051 | [-0.00506, +0.00398] | inconclusive |
| liquidity_minus50 | 0.5 | 5.0 | liquidity_waterfall | -0.00051 | [-0.00506, +0.00398] | inconclusive |
| liquidity_minus50 | 0.5 | 10.0 | liquidity_waterfall | -0.00051 | [-0.00506, +0.00398] | inconclusive |
| liquidity_minus50 | 1.0 | 1.0 | ppo_projected | +0.00065 | [-0.00841, +0.00956] | inconclusive |
| liquidity_minus50 | 1.0 | 5.0 | ppo_projected | +0.00065 | [-0.00841, +0.00956] | inconclusive |
| liquidity_minus50 | 1.0 | 10.0 | ppo_projected | +0.00065 | [-0.00841, +0.00956] | inconclusive |
| liquidity_minus50 | 2.0 | 1.0 | ppo_original | +0.00299 | [-0.01508, +0.02072] | inconclusive |
| liquidity_minus50 | 2.0 | 5.0 | ppo_projected | +0.00299 | [-0.01508, +0.02072] | inconclusive |
| liquidity_minus50 | 2.0 | 10.0 | ppo_projected | +0.00299 | [-0.01508, +0.02072] | inconclusive |
| cheapest_venue_outage | 0.5 | 1.0 | ppo_projected | +0.00183 | [-0.00010, +0.00397] | practically_negligible |
| cheapest_venue_outage | 0.5 | 5.0 | ppo_projected | +0.00183 | [-0.00010, +0.00397] | practically_negligible |
| cheapest_venue_outage | 0.5 | 10.0 | ppo_projected | +0.00183 | [-0.00010, +0.00397] | practically_negligible |
| cheapest_venue_outage | 1.0 | 1.0 | ppo_projected | +0.00458 | [+0.00054, +0.00917] | positive |
| cheapest_venue_outage | 1.0 | 5.0 | ppo_projected | +0.00458 | [+0.00054, +0.00917] | positive |
| cheapest_venue_outage | 1.0 | 10.0 | ppo_projected | +0.00458 | [+0.00054, +0.00917] | positive |
| cheapest_venue_outage | 2.0 | 1.0 | ppo_projected | +0.01010 | [+0.00180, +0.01951] | positive |
| cheapest_venue_outage | 2.0 | 5.0 | ppo_projected | +0.01010 | [+0.00180, +0.01951] | positive |
| cheapest_venue_outage | 2.0 | 10.0 | ppo_projected | +0.01010 | [+0.00180, +0.01951] | positive |
| congestion_x2 | 0.5 | 1.0 | liquidity_waterfall | -0.00047 | [-0.01646, +0.01494] | inconclusive |
| congestion_x2 | 0.5 | 5.0 | liquidity_waterfall | -0.00047 | [-0.01646, +0.01494] | inconclusive |
| congestion_x2 | 0.5 | 10.0 | liquidity_waterfall | -0.00047 | [-0.01646, +0.01494] | inconclusive |
| congestion_x2 | 1.0 | 1.0 | ppo_original | +0.00225 | [-0.02962, +0.03307] | inconclusive |
| congestion_x2 | 1.0 | 5.0 | ppo_projected | +0.00225 | [-0.02962, +0.03307] | inconclusive |
| congestion_x2 | 1.0 | 10.0 | ppo_projected | +0.00225 | [-0.02962, +0.03307] | inconclusive |
| congestion_x2 | 2.0 | 1.0 | cheapest_feasible | +0.00770 | [-0.05597, +0.06925] | inconclusive |
| congestion_x2 | 2.0 | 5.0 | ppo_original | +0.00770 | [-0.05597, +0.06925] | inconclusive |
| congestion_x2 | 2.0 | 10.0 | ppo_projected | +0.00770 | [-0.05597, +0.06925] | inconclusive |
| combined_stress | 0.5 | 1.0 | liquidity_waterfall | -0.00066 | [-0.00998, +0.00802] | inconclusive |
| combined_stress | 0.5 | 5.0 | liquidity_waterfall | -0.00066 | [-0.00998, +0.00802] | inconclusive |
| combined_stress | 0.5 | 10.0 | liquidity_waterfall | -0.00066 | [-0.00998, +0.00802] | inconclusive |
| combined_stress | 1.0 | 1.0 | ppo_original | +0.00098 | [-0.01775, +0.01827] | inconclusive |
| combined_stress | 1.0 | 5.0 | ppo_projected | +0.00098 | [-0.01775, +0.01827] | inconclusive |
| combined_stress | 1.0 | 10.0 | ppo_projected | +0.00098 | [-0.01775, +0.01827] | inconclusive |
| combined_stress | 2.0 | 1.0 | cheapest_feasible | +0.00428 | [-0.03326, +0.03878] | inconclusive |
| combined_stress | 2.0 | 5.0 | ppo_projected | +0.00428 | [-0.03326, +0.03878] | inconclusive |
| combined_stress | 2.0 | 10.0 | ppo_projected | +0.00428 | [-0.03326, +0.03878] | inconclusive |
