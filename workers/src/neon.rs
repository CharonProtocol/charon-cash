//! Neon serverless SQL over plain fetch(): POST {query, params} to
//! https://<host>/sql with the connection string in the Neon-Connection-String
//! header. No sockets, no TLS stack, no protocol state — the most robust
//! transport a Worker can have. Rows come back as JSON arrays aligned with
//! the fields list.

use serde_json::Value;

pub struct Neon {
    /// https://<pooler-host>
    base: String,
    /// The raw connection string, sent as the Neon-Connection-String header
    /// (the official serverless driver sends it raw too — no base64).
    auth: String,
}

impl Neon {
    /// Extracts the https base URL from a standard postgres connection string.
    pub fn from_connection_string(cs: &str) -> Result<Neon, String> {
        let rest = cs
            .strip_prefix("postgresql://")
            .or_else(|| cs.strip_prefix("postgres://"))
            .ok_or("neon: connection string must start with postgresql://")?;
        let host = rest
            .split('/')
            .next()
            .and_then(|h| h.split('?').next())
            .ok_or("neon: no host in connection string")?;
        if host.is_empty() {
            return Err("neon: empty host".into());
        }
        Ok(Neon {
            base: format!("https://{host}"),
            auth: cs.to_string(),
        })
    }

    fn to_json(v: &crate::store::V) -> Value {
        match v {
            crate::store::V::S(s) => Value::String(s.clone()),
            crate::store::V::I(i) => Value::Number((*i).into()),
        }
    }

    /// Runs one statement. Returns the rows as JSON objects keyed by column.
    pub async fn query(&self, sql: &str, params: &[crate::store::V]) -> Result<Vec<Value>, String> {
        let body = serde_json::json!({
            "query": sql,
            "params": params.iter().map(Self::to_json).collect::<Vec<_>>(),
        });
        let mut init = worker::RequestInit::new();
        init.with_method(worker::Method::Post)
            .with_headers({
                let mut h = worker::Headers::new();
                h.set("content-type", "application/json")
                    .map_err(|e| format!("neon header: {e}"))?;
                h.set("neon-connection-string", &self.auth)
                    .map_err(|e| format!("neon header: {e}"))?;
                h
            })
            .with_body(Some(serde_json::to_string(&body).map_err(|e| format!("neon body: {e}"))?.into()));
        let mut req = worker::Request::new_with_init(
            &format!("{}/sql", self.base),
            &init,
        )
        .map_err(|e| format!("neon request: {e}"))?;
        let mut res = worker::Fetch::Request(req)
            .send()
            .await
            .map_err(|e| format!("neon fetch: {e}"))?;
        let status = res.status_code();
        let text = res.text().await.map_err(|e| format!("neon read: {e}"))?;
        if status != 200 {
            return Err(format!("neon sql error ({status}): {}", &text[..text.len().min(300)]));
        }
        let parsed: Value =
            serde_json::from_str(&text).map_err(|e| format!("neon parse: {e}"))?;
        match parsed.get("rows") {
            Some(Value::Array(rows)) => Ok(rows.clone()),
            _ => Ok(Vec::new()),
        }
    }
}
