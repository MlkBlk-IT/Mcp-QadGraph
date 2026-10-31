# Mcp-QadGraph

A local dashboard and read-only MCP server for exploring a Qdrant vector database.

## What it shows

QadGraph helps make vector memory easier to inspect. It computes cosine similarity server-side and presents:

- a 3D similarity graph;
- collection and payload metrics;
- search and inspection views;
- logs and health information;
- read-only MCP tools for an AI client.

## Current status

The project is working against a local Qdrant setup, but it is not yet generalised.

The verified environment documented by the project uses Windows, Python 3.14 and Qdrant 1.19.2. The pure-Python similarity calculation is O(n² × dimension), so collection size matters.

## Quick start

Start Qdrant on `http://127.0.0.1:6333`, then install the project dependencies:

```powershell
python -m pip install -r requirements.txt
python qadgraph\server.py
```

The dashboard is served locally. The repository also contains the MCP configuration and test commands.

## Tests

```powershell
python -m unittest discover -s tests -v
```

The automated security tests do not require a live Qdrant collection.

## Limitations

- Local Qdrant is the supported target.
- The payload schema expects fields such as `type`, `session` and `text` or `summary`.
- Linux and macOS support are not verified.
- No performance benchmark is claimed for large collections.
- The MCP interface is read-only by design.

## Author

Built by [Malik Belkacemi](https://github.com/MlkBlk-IT).
