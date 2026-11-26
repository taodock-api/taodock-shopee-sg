# Privacy and data handling

Draft Checker for Shopee Singapore runs on your machine. The local server processes uploaded rule snapshots, product data and approved statements in memory. The page retains pasted content until you replace it, reload or close it. Reports and reviewed copy are saved only when you choose to download them. The tool uses no analytics, cookies or browser storage.

Local checks and local copy preparation send no data to Shopee or Taodock. If you load Taodock models, the local server sends your key to the Taodock HTTPS API in an authorisation header. If you request model ordering, the local server also sends the selected model and the approved statements for that one draft. Use statements approved for external processing. [Taodock](https://taodock.com)

Keep local credential files and downloaded reports private. The tool serves the interface on loopback.
