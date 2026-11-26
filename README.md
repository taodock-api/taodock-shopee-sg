# Draft Checker for Shopee Singapore

Review a batch of Shopee Singapore product listing drafts before entering them in Seller Centre. This independent Taodock tool checks category attributes, variation options, seller SKUs and product facts. It can prepare a title, selling points and description from approved statements.

[Download the release](https://github.com/taodock-api/taodock-shopee-sg/releases/latest) · [Report an issue](https://github.com/taodock-api/taodock-shopee-sg/issues) · [Privacy and data handling](PRIVACY.md)

## Start locally

Extract the release ZIP. In the extracted folder, run the following with Node.js 22 or later.

```sh
npm start
```

Open `http://127.0.0.1:8791`, then choose **Load sample batch** and **Check batch**. The fictional batch includes one passing draft and one with a missing child attribute and a conflicting capacity.

## Check your drafts

1. Obtain `v2.product.get_attribute_tree` output for leaf categories from an authorised Singapore shop. Optionally obtain `v2.product.get_item_limit` output for the same shop. In **Shopee rules**, supply these raw responses wrapped as shown below. Include both the response object and any outer status field. You can paste the JSON or import a local file.
2. In **Listing drafts**, provide a JSON array of up to 100 draft objects. Include `category_id`, `item_name` and `description`. The bundled [example](examples/demo.json) shows the batch format.
3. Choose **Check batch**. Open each draft’s findings to see the field and the issue. **Download report** exports the results as JSON.

```json
{
  "market": "SG",
  "attributeResponse": {
    "error": "",
    "response": {
      "list": [{"category_id": 99910001, "attribute_tree": []}]
    }
  }
}
```

The ID above is fictional. Replace it with your raw response data. To include title, description and image-count limits, add the full GetItemLimit response at `itemLimitResponse`. The checker reads `item_name_length_limit`, `item_description_length_limit` and `item_image_count_limit` from that response. Text limits use Unicode characters after trimming outer whitespace.

Use `attribute_list` entries with an `attribute_id` and an `attribute_value_list`. Select values by `value_id`. For a permitted custom value use `value_id: 0` with `original_value_name` and the required `value_unit`. Choose an associated parent option before entering a child attribute. The report flags attributes and searchable values that require extra review. Supply `image.image_id_list` when checking image counts. For variations, include `tier_variation` with `option_list` and `models` with zero-based `tier_index` arrays. Use `item_sku` and `model_sku` to check repeated seller SKUs.

If a draft includes `approved.measurements` or `approved.phrases`, use one measurement or required phrase per line. The checker compares supported quantities across equivalent units and flags recognised quantitative attribute values that conflict with approved measurements of the same kind.

[Product creation preparation](https://open.shopee.com/developer-guide/209) · [GetAttributeTree](https://open.shopee.com/documents/v2/v2.product.get_attribute_tree?module=89&type=1) · [GetItemLimit](https://open.shopee.com/documents/v2/v2.product.get_item_limit?module=89&type=1)

## Prepare listing copy

Include `approved.productName`, `approved.statements` with one approved statement per line, and at least one approved measurement or required phrase in each draft you want to generate. Choose **Prepare batch copy** to use the source order. Compare each title, bullet list and description with your product facts. Confirm the review before downloading. Paste the approved result into Seller Centre.

With an optional Taodock key, **Load Taodock models** lists the current models your key can use. Choose a text-capable model and a draft number. **Order selected draft with Taodock** sends that draft’s approved statements to suggest an order. The generated preview uses the approved name and the original statements in the selected order. Model use can consume your API credit. [Taodock API docs](https://docs.taodock.com)

To configure model access, copy `.env.example` to a local ignored `.env`, set `TAODOCK_API_KEY`, and run `node --env-file=.env src/server.mjs`. `PORT` changes the local port. Keep credential values in a secret manager or this ignored local file.

## Scope and reproduction

The local checker uses merchant-supplied Singapore rule snapshots. A passing report covers only the supplied checks. Seller eligibility, catalogue policy, searchable values, product claims and final approval still require review in Shopee. This version exports reports and copy for manual entry. It has no Shopee login or product submission feature.

Run `npm test` for the regression suite and `npm run package` to build the ZIP and its SHA-256 file. Rebuilding requires the system `zip` utility. The app has no third-party runtime dependencies. [MIT License](LICENSE)
