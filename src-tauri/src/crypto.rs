//! 网易云音乐 API 加密实现
//!
//! 对齐 NeteaseCloudMusicApi 的 util/crypto.js：
//!   - weapi: AES-128-CBC 两次（预设密钥 + 随机密钥）+ RSA 裸加密(无填充)
//!   - eapi : AES-128-ECB(密钥 e82ckenh8dichen8)，载荷带 MD5 校验段
//!
//! 已用 Node 端 crypto-js / node-forge 生成的测试向量逐字节校验。

use aes::cipher::{BlockEncrypt, KeyInit};
use aes::Aes128;
use base64::Engine as _;
use md5::{Digest, Md5};
use num_bigint::BigUint;
use rand::Rng;

const IV: &[u8; 16] = b"0102030405060708";
const PRESET_KEY: &[u8; 16] = b"0CoJUm6Qyw8W8jud";
const EAPI_KEY: &[u8; 16] = b"e82ckenh8dichen8";
const BASE62: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/// 网易云 weapi 1024-bit 公钥模数（n）
const RSA_MODULUS_HEX: &str = "e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
const RSA_EXPONENT: u32 = 0x10001;
const RSA_BYTES: usize = 128; // 1024-bit

fn pkcs7_pad(data: &[u8]) -> Vec<u8> {
    let pad = 16 - (data.len() % 16);
    let mut v = Vec::with_capacity(data.len() + pad);
    v.extend_from_slice(data);
    v.extend(std::iter::repeat(pad as u8).take(pad));
    v
}

/// AES-128-ECB 加密（含 PKCS7 填充），返回密文字节
fn aes_ecb_encrypt(key: &[u8], data: &[u8]) -> Vec<u8> {
    let cipher = Aes128::new_from_slice(key).expect("AES key 长度必须为 16 字节");
    let mut buf = pkcs7_pad(data);
    for chunk in buf.chunks_mut(16) {
        let block = aes::cipher::Block::<Aes128>::from_mut_slice(chunk);
        cipher.encrypt_block(block);
    }
    buf
}

/// AES-128-CBC 加密（含 PKCS7 填充），返回密文字节
fn aes_cbc_encrypt(key: &[u8], iv: &[u8], data: &[u8]) -> Vec<u8> {
    let cipher = Aes128::new_from_slice(key).expect("AES key 长度必须为 16 字节");
    let mut buf = pkcs7_pad(data);
    let mut prev = [0u8; 16];
    prev.copy_from_slice(&iv[..16]);
    for chunk in buf.chunks_mut(16) {
        for i in 0..16 {
            chunk[i] ^= prev[i];
        }
        {
            let block = aes::cipher::Block::<Aes128>::from_mut_slice(&mut chunk[..16]);
            cipher.encrypt_block(block);
        }
        prev.copy_from_slice(&chunk[..16]);
    }
    buf
}

/// RSA 裸加密（无填充），等价于 node-forge 的 publicKey.encrypt(str, "NONE")
fn rsa_raw_encrypt(text: &str) -> String {
    let n = BigUint::parse_bytes(RSA_MODULUS_HEX.as_bytes(), 16).expect("模数解析失败");
    let m = BigUint::from_bytes_be(text.as_bytes());
    let e = BigUint::from(RSA_EXPONENT);
    let c = m.modpow(&e, &n);
    let bytes = c.to_bytes_be();

    let mut out = vec![0u8; RSA_BYTES];
    if bytes.len() <= RSA_BYTES {
        out[RSA_BYTES - bytes.len()..].copy_from_slice(&bytes);
    } else {
        out.copy_from_slice(&bytes[bytes.len() - RSA_BYTES..]);
    }
    hex::encode(out)
}

fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// weapi 加密，返回 (params, encSecKey)
pub fn weapi(obj: &serde_json::Value) -> (String, String) {
    let text = serde_json::to_string(obj).expect("JSON 序列化失败");

    // 第一次：预设密钥加密
    let first = base64_encode(&aes_cbc_encrypt(PRESET_KEY, IV, text.as_bytes()));

    // 随机 16 位 base62 密钥
    let mut rng = rand::thread_rng();
    let secret: String = (0..16)
        .map(|_| BASE62[rng.gen_range(0..BASE62.len())] as char)
        .collect();

    // 第二次：用随机密钥加密第一次的结果
    let params = base64_encode(&aes_cbc_encrypt(secret.as_bytes(), IV, first.as_bytes()));

    // RSA 加密「反向的随机密钥」
    let reversed: String = secret.chars().rev().collect();
    let enc_sec_key = rsa_raw_encrypt(&reversed);

    (params, enc_sec_key)
}

/// eapi 加密，返回 params（大写十六进制）
pub fn eapi(uri: &str, data: &serde_json::Value) -> String {
    let text = serde_json::to_string(data).expect("JSON 序列化失败");
    let message = format!("nobody{}use{}md5forencrypt", uri, text);
    let digest = hex::encode(Md5::digest(message.as_bytes()).as_slice());
    let payload = format!("{}-36cd479b6b5-{}-36cd479b6b5-{}", uri, text, digest);
    hex::encode_upper(aes_ecb_encrypt(EAPI_KEY, payload.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weapi_first_stage_matches_node() {
        let text = "{\"s\":\"周杰伦\",\"type\":1,\"limit\":30,\"offset\":0,\"total\":true}";
        let first = base64_encode(&aes_cbc_encrypt(PRESET_KEY, IV, text.as_bytes()));
        assert_eq!(
            first,
            "V9Vu+x+fuurEfbP2qyBZjLW8Y/9MQpQAQ/OgvaAIsG+lvh4uotcUz+mLu22NTSohuMrmKEN8EpmMzXHHi96i/Q=="
        );
    }

    #[test]
    fn weapi_second_stage_matches_node() {
        let first = "V9Vu+x+fuurEfbP2qyBZjLW8Y/9MQpQAQ/OgvaAIsG+lvh4uotcUz+mLu22NTSohuMrmKEN8EpmMzXHHi96i/Q==";
        let params = base64_encode(&aes_cbc_encrypt(b"abcdefghijklmnop", IV, first.as_bytes()));
        assert_eq!(
            params,
            "n2nXn8LzSZtTIMti/1xqFj8ty1MsbACFXv/oTT3sFQEupxmsNDB5jm+nJIY8UvZVCZCGGvmWVsmfHUrtdZvRkNdP01iycV5FrOoFhM2rzEUk0KvGQ42CizNvheM1BAgu"
        );
    }

    #[test]
    fn rsa_matches_node() {
        let enc = rsa_raw_encrypt("ponmlkjihgfedcba");
        assert_eq!(
            enc,
            "d15a1683c992095d0c234c19966605c5c5964911268bbeda8cb8d08d834913e59d53b32358903a121b5fca784c1f5ae44951fd02524df58ecc98e52cc7cf8689b42c2e93ddf05b0592512d87f5960467e2f086c018849d76014d323500e30f13ef4cafbb0cf5a66731a3f1776c75ca35d0062dac70a3e33245afabcf47938487"
        );
    }

    /// 用单键对象做向量，避免 JSON 键顺序干扰（serde_json 默认按字典序排序）
    #[test]
    fn eapi_matches_node() {
        let obj = serde_json::json!({ "kw": "test" });
        let p = eapi("/api/cloudsearch/pc", &obj);
        assert_eq!(
            p,
            "2B5D64177AA6460FBAA3DCB1285E28954BBB4F7556E09B0FB25750F12398BB501FD3F9CAB3F49F9E38196256EEA0FCD880541A3FD30EAD6EF982FFD5892CB63EC8B8578C95F5ECBE7CCD40926620F0F6F3B5B515A7ABCD26787F3DF17263D1B6"
        );
    }
}
