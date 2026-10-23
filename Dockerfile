# QadGraph — MCP stdio image (for Glama checks / container use)
# Dashboard (stdlib HTTP) needs a reachable Qdrant; the MCP server is read-only stdio.
FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir mcp

COPY qadgraph/ qadgraph/

ENV QADGRAPH_QDRANT=http://127.0.0.1:6333 \
    QADGRAPH_COLLECTION=hermes_qwen3_memory \
    QADGRAPH_HOST=127.0.0.1 \
    QADGRAPH_PORT=8766

# Default: MCP over stdio (introspection-friendly). Override for the dashboard:
#   docker run -p 8766:8766 IMAGE python qadgraph/server.py
CMD ["python", "qadgraph/mcp/qadgraph_mcp.py"]
