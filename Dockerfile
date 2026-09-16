FROM rust:1.98.1-bookworm AS wasm
RUN rustup target add wasm32-unknown-unknown && cargo install wasm-bindgen-cli --version 0.2.126 --locked
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --locked --release --target wasm32-unknown-unknown -p yfinance-core && wasm-bindgen --target web --out-dir /wasm --out-name financial_core target/wasm32-unknown-unknown/release/yfinance_core.wasm

FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web ./
COPY --from=wasm /wasm ./src/wasm
RUN npm run build:ui

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=web /app/web/dist ./dist
COPY --from=web /app/web/server ./server
USER node
EXPOSE 3000
CMD ["node", "server/index.mjs"]
