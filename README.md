# Torn War Report

A [Torn City](https://www.torn.com) userscript that builds a **per-member ranked-war report** for your own faction. Pick any of your faction's finished wars and see, for every member:

- **War hits** — successful ranked-war attacks
- **Outside hits** — successful non-war attacks made during the war window
- **Respect** gained
- **Attacked / Hit / Defended** — how many times the enemy attacked that member, how many of those landed, and how many they fought off

Works on desktop browsers (Tampermonkey / Violentmonkey) and inside **Torn PDA**.

---

## What it does

1. Lists your faction's **finished** ranked wars (`/faction/rankedwars`).
2. On the war you pick, pulls the official war report (`/faction/{id}/rankedwarreport`) for scores and the enemy summary.
3. Reads the **whole faction attack log** for the war window (`/faction/attacks`), paged 100 at a time, and folds it into a per-member table.
4. Splits every attack into **war vs outside** (via the `is_ranked_war` flag) and **outgoing vs incoming**, so you get both what each member dealt out and what they took.

The numbers are cross-checked against Torn's official report: per-member war-hit counts and respect match the report exactly.

---

## Columns (your faction)

| Column | Meaning |
|---|---|
| **War hits** | Successful attacks that counted for the war |
| **Outside hits** | Successful attacks during the war that did **not** count for the war |
| **Total hits** | War + outside |
| **Respect** | Respect gained from successful attacks |
| **Attacked** | Times the enemy attacked this member |
| **Hit** | Times the enemy's attack landed (member was beaten) |
| **Defended** | Times the member fought the attacker off |

Click any column header to sort. A totals row sums the whole faction.

---

## Requirements

- **API key level:** a **Limited Access** key (or higher).
- **Faction permission:** your faction position must have **API access** enabled. Without it Torn refuses the attack log with *error 7* — a public/minimal key is **not** enough. Ask your faction leader to enable API access for your position, or use a key from a member who has it.

Get a key at **Settings → API** on torn.com. The key is stored only in your browser and is sent only to `api.torn.com`.

---

## Install

1. Install a userscript manager (Tampermonkey / Violentmonkey).
2. Open [`torn-war-report.user.js`](./torn-war-report.user.js) and paste its contents into a new script.
3. Open any `torn.com` page, click the icon in the footer, paste your API key, pick a war, and hit **Generate report**.

---

## Limitations

- **Your faction only.** Torn only exposes your own faction's attack log. For the **enemy** you get a totals-only summary (attacks + score per member) from the official report — their per-attack detail isn't readable via the API.
- **Finished wars only.** Ongoing wars are hidden — they have no final report and only a partial log.
- **A full war is slow.** The attack log is read in pages of 100, paced to stay under Torn's 100-requests-per-minute ceiling. A busy war is a few thousand attacks (~30 pages, roughly 20–40 seconds). If Torn rate-limits (error 5) the fetch pauses 60 seconds with a visible countdown and resumes exactly where it stopped. Keep the panel open until it finishes.
- **War vs outside** relies on Torn's `is_ranked_war` flag. It can be off by one or two attacks at the war boundary compared to the official tally (interrupted / assist edge cases).

---

## Privacy

- No backend, no telemetry. The script talks only to `api.torn.com`.
- Your API key lives in this browser's `localStorage` and nowhere else. Remove it any time from **Settings → Remove key**.

---

## Like the script?

Send a Xanax to [eugene_s [4192025]](https://www.torn.com/profiles.php?XID=4192025).
