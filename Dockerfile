FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
ENV TK_ADMIN_STATE_DIR=/data

WORKDIR /app
RUN pip install --no-cache-dir "Pillow>=11.3,<13"

COPY server/admin.py server/publisher.py ./server/
COPY admin.html admin.css admin.js styles.css ./dist/
COPY data/catalog.js ./dist/data/
COPY assets/ ./dist/assets/

CMD ["python", "-B", "server/admin.py"]
