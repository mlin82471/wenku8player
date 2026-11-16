//! 网易云音乐 API 客户端
//!
//! 与 NeteaseCloudMusicApi（Node 版）的行为对齐：
//!   - 默认 eapi（util/config.json 中 APP_CONF.encrypt = true）
//!   - 登录 / 账号 / 歌单 / 推荐 / 评论 / 红心 走 weapi
//!   - cookie 由前端通过 query 参数 cookie 透传，这里补齐设备指纹字段

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::crypto;

const DOMAIN: &str = "https://music.163.com";
const API_DOMAIN: &str = "https://interface.music.163.com";

const UA_WEAPI: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
const UA_API_IPHONE: &str = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.164 Safari/537.36 NeteaseMusicDesktop/3.1.17.204416";

const OS_OSVER: &str = "Microsoft-Windows-10-Professional-build-19045-64bit";
const OS_APPVER: &str = "3.1.17.204416";
const OS_CHANNEL: &str = "netease";

/// 需要额外放行的业务状态码（二维码轮询等）
#[allow(dead_code)]
const SPECIAL_CODES: [i64; 8] = [201, 302, 400, 502, 800, 801, 802, 803];

const FORM: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~')
    .remove(b'!')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

fn enc(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, FORM).to_string()
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn rand_hex(bytes: usize) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..bytes).map(|_| format!("{:02x}", rng.gen::<u8>())).collect()
}

fn rand_alpha(n: usize) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..n)
        .map(|_| (b'a' + rng.gen_range(0..26u8)) as char)
        .collect()
}

#[derive(Clone, Copy, PartialEq)]
pub enum Crypto {
    Weapi,
    Eapi,
}

#[derive(Clone)]
pub struct DeviceFingerprint {
    pub nuid: String,
    pub nnid: String,
    pub wnmcid: String,
    pub nmtid: String,
}

impl DeviceFingerprint {
    pub fn new() -> Self {
        let nuid = rand_hex(32);
        let now = now_millis();
        Self {
            nnid: format!("{},{}", nuid, now),
            wnmcid: format!("{}.{}.01.0", rand_alpha(6), now),
            nmtid: rand_hex(16),
            nuid,
        }
    }
}

/// 解析前端 cookie 字符串，补齐设备指纹字段（对齐 processCookieObject）
fn process_cookie(cookie_raw: &str, uri: &str, fp: &DeviceFingerprint) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = Vec::new();

    for item in cookie_raw.split(';') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        if let Some((k, v)) = item.split_once('=') {
            let k = k.trim().to_string();
            let v = v.trim().to_string();
            if !k.is_empty() {
                pairs.retain(|(kk, _)| kk != &k);
                pairs.push((k, v));
            }
        }
    }

    let has = |pairs: &Vec<(String, String)>, key: &str| pairs.iter().any(|(k, _)| k == key);

    let set_default = |pairs: &mut Vec<(String, String)>, key: &str, val: String| {
        if !has(pairs, key) {
            pairs.push((key.to_string(), val));
        }
    };

    set_default(&mut pairs, "__remember_me", "true".into());
    set_default(&mut pairs, "ntes_kaola_ad", "1".into());
    set_default(&mut pairs, "_ntes_nuid", fp.nuid.clone());
    set_default(&mut pairs, "_ntes_nnid", fp.nnid.clone());
    set_default(&mut pairs, "WNMCID", fp.wnmcid.clone());
    set_default(&mut pairs, "WEVNSM", "1.0.0".into());
    set_default(&mut pairs, "osver", OS_OSVER.into());
    set_default(&mut pairs, "os", "pc".into());
    set_default(&mut pairs, "channel", OS_CHANNEL.into());
    set_default(&mut pairs, "appver", OS_APPVER.into());

    // 登录相关请求不注入 NMTID
    if !uri.contains("login") && !has(&pairs, "NMTID") {
        pairs.push(("NMTID".into(), fp.nmtid.clone()));
    }

    pairs
}

/// 把响应 Set-Cookie 合并进已有 cookie（同名项以新值为准）
fn merge_cookies(cookie_raw: &str, set_cookie: &str) -> String {
    let mut pairs: Vec<(String, String)> = Vec::new();

    for item in cookie_raw.split(';').chain(set_cookie.split(';')) {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let Some((k, v)) = item.split_once('=') else {
            continue;
        };
        let k = k.trim();
        if k.is_empty() {
            continue;
        }
        pairs.retain(|(kk, _)| kk != k);
        pairs.push((k.to_string(), v.trim().to_string()));
    }

    pairs
        .into_iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("; ")
}

fn get<'a>(pairs: &'a [(String, String)], key: &str) -> String {
    pairs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

pub fn sanitize_numeric_ids(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("缺少必要的 ID 参数".into());
    }
    for part in trimmed.split(',') {
        let p = part.trim();
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
            return Err(format!("非法的 ID 参数: {}", id));
        }
    }
    Ok(trimmed.to_string())
}

pub struct NcmClient {
    pub http: reqwest::Client,
    pub fp: DeviceFingerprint,
}

impl NcmClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .gzip(true)
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("创建 HTTP 客户端失败");
        Self {
            http,
            fp: DeviceFingerprint::new(),
        }
    }

    /// 发送一次网易云 API 请求，返回原始响应 body
    async fn request(
        &self,
        uri: &str,
        data: Value,
        mode: Crypto,
        cookie_raw: &str,
    ) -> Result<Value, String> {
        self.request_with_cookie(uri, data, mode, cookie_raw)
            .await
            .map(|(body, _)| body)
    }

    /// 发送请求并保留响应头里的 Set-Cookie（扫码登录取登录态必需）
    ///
    /// 第二个返回值是「请求 cookie + 响应 Set-Cookie」合并后的完整 cookie，
    /// 便于前端直接保存，不再每次请求都换一套随机设备指纹。
    async fn request_with_cookie(
        &self,
        uri: &str,
        mut data: Value,
        mode: Crypto,
        cookie_raw: &str,
    ) -> Result<(Value, Option<String>), String> {
        let pairs = process_cookie(cookie_raw, uri, &self.fp);
        let csrf = get(&pairs, "__csrf");

        // data.e_r 默认 false（APP_CONF.encryptResponse = false）
        if let Some(obj) = data.as_object_mut() {
            obj.entry("e_r").or_insert(json!(false));
        }

        let (url, body, headers) = match mode {
            Crypto::Weapi => {
                if let Some(obj) = data.as_object_mut() {
                    obj.insert("csrf_token".into(), json!(csrf));
                }
                let (params, enc_sec_key) = crypto::weapi(&data);
                let body = format!("params={}&encSecKey={}", enc(&params), enc(&enc_sec_key));
                let cookie_header = pairs
                    .iter()
                    .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
                    .collect::<Vec<_>>()
                    .join("; ");
                let url = format!("{}/weapi/{}", DOMAIN, &uri[5..]);
                (
                    url,
                    body,
                    vec![
                        ("Referer".to_string(), DOMAIN.to_string()),
                        ("User-Agent".to_string(), UA_WEAPI.to_string()),
                        ("Cookie".to_string(), cookie_header),
                    ],
                )
            }
            Crypto::Eapi => {
                let now = now_millis();
                let mut header = Map::new();
                header.insert("osver".into(), json!(get(&pairs, "osver")));
                header.insert("deviceId".into(), json!(get(&pairs, "deviceId")));
                header.insert("os".into(), json!(get(&pairs, "os")));
                header.insert("appver".into(), json!(get(&pairs, "appver")));
                header.insert("versioncode".into(), json!("140"));
                header.insert("mobilename".into(), json!(""));
                header.insert("buildver".into(), json!((now / 1000).to_string()));
                header.insert("resolution".into(), json!("1920x1080"));
                header.insert("__csrf".into(), json!(csrf));
                header.insert("channel".into(), json!(get(&pairs, "channel")));
                {
                    use rand::Rng;
                    let rid = format!("{}_{:04}", now, rand::thread_rng().gen_range(0..1000));
                    header.insert("requestId".into(), json!(rid));
                }

                let music_u = get(&pairs, "MUSIC_U");
                if !music_u.is_empty() {
                    header.insert("MUSIC_U".into(), json!(music_u));
                }
                let music_a = get(&pairs, "MUSIC_A");
                if !music_a.is_empty() {
                    header.insert("MUSIC_A".into(), json!(music_a));
                }

                let cookie_header = header
                    .iter()
                    .map(|(k, v)| {
                        let vs = v.as_str().map(|s| s.to_string()).unwrap_or_default();
                        format!("{}={}", enc(k), enc(&vs))
                    })
                    .collect::<Vec<_>>()
                    .join("; ");

                if let Some(obj) = data.as_object_mut() {
                    obj.insert("header".into(), Value::Object(header));
                }
                let params = crypto::eapi(uri, &data);
                let url = format!("{}/eapi/{}", API_DOMAIN, &uri[5..]);
                (
                    url,
                    format!("params={}", enc(&params)),
                    vec![
                        ("User-Agent".to_string(), UA_API_IPHONE.to_string()),
                        ("Cookie".to_string(), cookie_header),
                    ],
                )
            }
        };

        let mut req = self
            .http
            .post(&url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("X-Real-IP", "116.25.146.177")
            .header("X-Forwarded-For", "116.25.146.177");
        for (k, v) in headers {
            req = req.header(k, v);
        }

        let resp = req.body(body).send().await.map_err(|e| format!("网络请求失败: {}", e))?;
        let status = resp.status();

        // 先收集 Set-Cookie（同名只保留最后一次设置），再消费响应体
        let mut set_cookies: Vec<String> = Vec::new();
        for value in resp.headers().get_all(reqwest::header::SET_COOKIE).iter() {
            let Ok(raw) = value.to_str() else { continue };
            let Some(pair) = raw.split(';').next() else { continue };
            let pair = pair.trim();
            if !pair.contains('=') {
                continue;
            }
            let name = pair.split('=').next().unwrap_or("");
            set_cookies.retain(|c| c.split('=').next() != Some(name));
            set_cookies.push(pair.to_string());
        }

        let text = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        let body = parse_body(&text, status.as_u16())?;

        let merged_cookie = if set_cookies.is_empty() {
            None
        } else {
            let base = pairs
                .iter()
                .map(|(k, v)| format!("{}={}", k, v))
                .collect::<Vec<_>>()
                .join("; ");
            Some(merge_cookies(&base, &set_cookies.join("; ")))
        };

        Ok((body, merged_cookie))
    }

    // ------------------------------------------------------------------
    // 1. 二维码登录
    // ------------------------------------------------------------------

    pub async fn qr_key(&self, cookie: &str) -> Result<Value, String> {
        // 与 NeteaseCloudMusicApi 对齐：weapi + type 1
        let (body, _) = self
            .request_with_cookie(
                "/api/login/qrcode/unikey",
                json!({ "type": 1 }),
                Crypto::Weapi,
                cookie,
            )
            .await?;
        Ok(json!({
            "status": 200,
            "code": 200,
            "body": body.clone(),
            "data": body,
        }))
    }

    pub fn qr_create(&self, key: &str, with_img: bool) -> Value {
        let url = format!("https://music.163.com/login?codekey={}", key);
        let qrimg = if with_img {
            qr_data_url(&url)
        } else {
            String::new()
        };
        // 前端读取 imgJ.data.qrimg，因此 qrurl/qrimg 必须直接位于 data 下
        json!({
            "code": 200,
            "status": 200,
            "data": { "code": 200, "qrurl": url, "qrimg": qrimg },
            "body": { "code": 200, "qrurl": url, "qrimg": qrimg },
        })
    }

    pub async fn qr_check(&self, key: &str, cookie: &str) -> Result<Value, String> {
        let (mut body, merged_cookie) = self
            .request_with_cookie(
                "/api/login/qrcode/client/login",
                json!({ "key": key, "type": 1 }),
                Crypto::Weapi,
                cookie,
            )
            .await
            .unwrap_or_else(|_| (json!({ "code": 502 }), None));

        // 登录成功（803）时把完整 cookie 回传给前端保存
        if let Some(cookie) = merged_cookie {
            body["cookie"] = json!(cookie);
        }
        Ok(body)
    }

    // ------------------------------------------------------------------
    // 2. 账号 / 歌单
    // ------------------------------------------------------------------

    pub async fn user_account(&self, cookie: &str) -> Result<Value, String> {
        self.request("/api/nuser/account/get", json!({}), Crypto::Weapi, cookie)
            .await
    }

    pub async fn user_playlist(&self, cookie: &str, q: &HashMap<String, String>) -> Result<Value, String> {
        let uid = q.get("uid").cloned().unwrap_or_default();
        let limit: i64 = q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(30);
        let offset: i64 = q.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0);
        self.request(
            "/api/user/playlist",
            json!({"uid": uid, "limit": limit, "offset": offset, "includeVideo": true}),
            Crypto::Weapi,
            cookie,
        )
        .await
    }

    pub async fn playlist_detail(&self, cookie: &str, q: &HashMap<String, String>) -> Result<Value, String> {
        let id = sanitize_numeric_ids(q.get("id").map(|s| s.as_str()).unwrap_or(""))?;
        self.request(
            "/api/v6/playlist/detail",
            json!({"id": id, "n": 1000, "s": 8}),
            Crypto::Eapi,
            cookie,
        )
        .await
    }

    pub async fn playlist_track_all(&self, cookie: &str, q: &HashMap<String, String>) -> Result<Value, String> {
        let id = sanitize_numeric_ids(q.get("id").map(|s| s.as_str()).unwrap_or(""))?;
        let limit: usize = q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(1000);
        let offset: usize = q.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0);

        let detail = self
            .request(
                "/api/v6/playlist/detail",
                json!({"id": id, "n": 100000, "s": 8}),
                Crypto::Eapi,
                cookie,
            )
            .await?;

        let track_ids = detail
            .get("playlist")
            .and_then(|p| p.get("trackIds"))
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        let items: Vec<String> = track_ids
            .iter()
            .skip(offset)
            .take(limit)
            .map(|t| format!("{{\"id\":{}}}", t.get("id").and_then(|v| v.as_i64()).unwrap_or(0)))
            .collect();
        let c = format!("[{}]", items.join(","));

        self.request("/api/v3/song/detail", json!({"c": c}), Crypto::Eapi, cookie)
            .await
    }

    pub async fn recommend_songs(&self, cookie: &str) -> Result<Value, String> {
        self.request(
            "/api/v3/discovery/recommend/songs",
            json!({}),
            Crypto::Weapi,
            cookie,
        )
        .await
    }

    // ------------------------------------------------------------------
    // 3. 搜索 / 播放直链 / 歌词 / 评论 / 红心
    // ------------------------------------------------------------------

    pub async fn cloudsearch(&self, cookie: &str, q: &HashMap<String, String>) -> Result<Value, String> {
        let keywords = q.get("keywords").cloned().unwrap_or_default();
        let ty: i64 = q.get("type").and_then(|s| s.parse().ok()).unwrap_or(1);
        let limit: i64 = q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(30);
        let offset: i64 = q.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0);
        self.request(
            "/api/cloudsearch/pc",
            json!({"s": keywords, "type": ty, "limit": limit, "offset": offset, "total": true}),
            Crypto::Eapi,
            cookie,
        )
        .await
    }

    pub async fn song_url(&self, cookie: &str, q: &HashMap<String, String>) -> Result<Value, String> {
        let id = sanitize_numeric_ids(q.get("id").map(|s| s.as_str()).unwrap_or(""))?;
        let br: i64 = q.get("br").and_then(|s| s.parse().ok()).unwrap_or(999000);
        let ids: Vec<String> = id.split(',').map(|s| s.to_string()).collect();
        let body = self
            .request(
                "/api/song/enhance/player/url",
                json!({"ids": serde_json::to_string(&ids).unwrap(), "br": br}),
                Crypto::Eapi,
                cookie,
            )
            .await;

        let body = match body {
            Ok(ref val) if val.pointer("/data/0/url").and_then(|u| u.as_str()).map(|s| !s.is_empty()).unwrap_or(false) => {
                val.clone()
            }
            _ => {
                // 回退到 weapi 模式重试
                if let Ok(wres) = self.request(
                    "/api/song/enhance/player/url",
                    json!({"ids": ids, "br": br}),
                    Crypto::Weapi,
                    cookie,
                ).await {
                    wres
                } else {
                    body?
                }
            }
        };

        let mut data = body
            .get("data")
            .and_then(|d| d.as_array())
            .cloned()
            .unwrap_or_default();
        data.sort_by_key(|item| {
            let sid = item.get("id").and_then(|v| v.as_i64()).map(|v| v.to_string());
            ids.iter().position(|x| Some(x.clone()) == sid).unwrap_or(usize::MAX)
        });

        Ok(json!({"code": 200, "data": data}))
    }

    pub async fn song_url_v1(&self, cookie: &str, q: &HashMap<String, String>) -> Result<Value, String> {
        let id = sanitize_numeric_ids(q.get("id").map(|s| s.as_str()).unwrap_or(""))?;
        let level = q.get("level").cloned().unwrap_or_else(|| "standard".into());
        let mut data = json!({
            "ids": format!("[{}]", id),
            "level": level,
            "encodeType": "flac",
        });
        if level == "sky" {
            data["immerseType"] = json!("c51");
        }
        let res = self.request("/api/song/enhance/player/url/v1", data.clone(), Crypto::Eapi, cookie).await;
        if let Ok(ref val) = res {
            if val.get("code").and_then(|c| c.as_i64()) == Some(-460) {
                // EAPI 命中风控，自动无感退回到 weapi 渠道获取
                let weapi_data = json!({
                    "ids": format!("[{}]", id),
                    "level": level,
                    "encodeType": "flac"
                });
                if let Ok(wval) = self.request("/api/song/enhance/player/url/v1", weapi_data, Crypto::Weapi, cookie).await {
                    return Ok(wval);
                }
            }
        }
        res
    }

    pub async fn lyric(&self, cookie: &str, q: &HashMap<String, String>) -> Result<Value, String> {
        let id = sanitize_numeric_ids(q.get("id").map(|s| s.as_str()).unwrap_or(""))?;
        self.request(
            "/api/song/lyric",
            json!({"id": id, "tv": -1, "lv": -1, "rv": -1, "kv": -1, "_nmclfl": 1}),
            Crypto::Eapi,
            cookie,
        )
        .await
    }

    pub async fn comment_music(&self, cookie: &str, q: &HashMap<String, String>) -> Result<Value, String> {
        let id = sanitize_numeric_ids(q.get("id").map(|s| s.as_str()).unwrap_or(""))?;
        let limit: i64 = q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(20);
        let offset: i64 = q.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0);
        let uri = format!("/api/v1/resource/comments/R_SO_4_{}", id);
        self.request(
            &uri,
            json!({"rid": id, "limit": limit, "offset": offset, "beforeTime": 0}),
            Crypto::Weapi,
            cookie,
        )
        .await
    }

    pub async fn like(&self, cookie: &str, q: &HashMap<String, String>) -> Result<Value, String> {
        let id = sanitize_numeric_ids(q.get("id").map(|s| s.as_str()).unwrap_or(""))?;
        let like = q.get("like").map(|v| v != "false").unwrap_or(true);
        self.request(
            "/api/radio/like",
            json!({"alg": "itembased", "trackId": id, "like": like, "time": "3"}),
            Crypto::Weapi,
            cookie,
        )
        .await
    }
}

fn parse_body(text: &str, http_status: u16) -> Result<Value, String> {
    let mut body: Value = serde_json::from_str(text)
        .map_err(|_| format!("响应不是合法 JSON (HTTP {})：{}", http_status, preview(text)))?;

    // code 统一转成数字
    if let Some(code) = body.get("code").cloned() {
        if let Some(s) = code.as_str() {
            if let Ok(n) = s.parse::<i64>() {
                body["code"] = json!(n);
            }
        }
    }
    Ok(body)
}

fn preview(text: &str) -> String {
    let t: String = text.chars().take(160).collect();
    t.replace('\n', " ")
}

/// 生成二维码 SVG data URL
fn qr_data_url(content: &str) -> String {
    match qrcode::QrCode::new(content.as_bytes()) {
        Ok(code) => {
            let svg = code
                .render::<qrcode::render::svg::Color>()
                .min_dimensions(200, 200)
                .build();
            use base64::Engine as _;
            let b64 = base64::engine::general_purpose::STANDARD.encode(svg.as_bytes());
            format!("data:image/svg+xml;base64,{}", b64)
        }
        Err(e) => {
            eprintln!("[ncm] 二维码生成失败: {}", e);
            String::new()
        }
    }
}
