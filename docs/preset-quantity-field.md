# Draft — quantity field fix in CoMapeo preset

Root fix for messy quantities (`"13,170+14,110+..."`, `"6340kg"`, `"3"`):
replace free-text `quantity` in the field preset with structured entry.
Dashboard normalization (already live) is the workaround; this is the cure
for future records.

## Current problem

`quantity` is a free-text tag. Field team improvises:
- pt-BR decimal comma (`1,176` = 1.176 kg)
- `+`-joined per-bed amounts (one observation covers canteiros 5 e 8)
- kg suffix on gram values (`6340kg` meaning 6.340 g)
- bare counts (`3` mushrooms)

## Proposed field set

Replace single `quantity` with two tags:

1. **`quantity-per-bed`** — type `number`. Amount for ONE canteiro/row.
   If observation spans several beds, either record one observation per bed
   (preferred — gives per-bed map points) or use the repeat/multi field.
2. **`quantity-unit`** — type `selectOne`, options:
   - `kg`
   - `g`
   - `unidades` (count)
   - `molhos` (bunches)
   - `bandejas` (trays)

Preset JSON fragment (CoMapeo project config format):

```json
{
  "tags": [
    {
      "id": "quantity-per-bed",
      "type": "number",
      "label": "Quantidade (por canteiro)",
      "placeholder": "ex: 13.2",
      "helperText": "Peso ou contagem de UM canteiro. Use ponto para decimais."
    },
    {
      "id": "quantity-unit",
      "type": "selectOne",
      "label": "Unidade",
      "options": [
        { "value": "kg", "label": "kg" },
        { "value": "g", "label": "g" },
        { "value": "unidades", "label": "unidades" },
        { "value": "molhos", "label": "molhos" },
        { "value": "bandejas", "label": "bandejas" }
      ]
    }
  ]
}
```

Adapt ids/types to the actual preset schema version in use — check an
exported project config first (CoMapeo Desktop: project settings →
export/config). Test on a scratch project before replacing the live preset.

## Migration notes

- Existing 9 quantity-bearing records keep raw text; dashboard already
  normalizes them. No backfill needed.
- After preset change, update `tools/gen_data.py` parse rules to read the
  new fields directly (cleaner path: `quantityKg` from
  `quantity-per-bed` × unit, no heuristics).
- Display convention for the team: decimals with point in the app; the
  dashboard formats pt-BR commas.

## Open questions for the farm team

1. Gram-scale entries (`5846`) — grams, or stalk/bunch counts per crop?
2. One observation per bed acceptable, or keep multi-bed records?
3. Additional units needed (litros for milk, dúzias for eggs)?
