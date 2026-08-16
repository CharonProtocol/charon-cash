use serde_json::json;
use worker::{Response, ResponseBuilder};

#[derive(Debug)]
pub struct AppError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into() }
    }

    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(400, code, message)
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(409, code, message)
    }

    pub fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(404, code, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(401, "UNAUTHORIZED", message)
    }

    pub fn upstream(message: impl Into<String>) -> Self {
        Self::new(502, "UPSTREAM_ERROR", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, "INTERNAL_ERROR", message)
    }

    pub fn to_response(&self) -> Response {
        let body = json!({ "error": { "code": self.code, "message": self.message } });
        let text = serde_json::to_string(&body).unwrap_or_default();
        ResponseBuilder::new()
            .with_status(self.status)
            .with_header("content-type", "application/json")
            .unwrap()
            .body(worker::ResponseBody::Body(text.into_bytes()))
    }
}

pub type AppResult<T> = Result<T, AppError>;
