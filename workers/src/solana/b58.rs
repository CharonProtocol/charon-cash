const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

pub fn encode(bytes: &[u8]) -> String {
    let mut digits: Vec<u8> = Vec::with_capacity(bytes.len() * 2);
    for &b in bytes {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::with_capacity(digits.len() + bytes.len());
    for &b in bytes {
        if b == 0 {
            out.push('1');
        } else {
            break;
        }
    }
    for &d in digits.iter().rev() {
        out.push(ALPHABET[d as usize] as char);
    }
    out
}

pub fn decode(s: &str) -> Option<Vec<u8>> {
    let mut bytes: Vec<u8> = Vec::with_capacity(s.len());
    for c in s.bytes() {
        let val = ALPHABET.iter().position(|&a| a == c)? as u32;
        let mut carry = val;
        for b in bytes.iter_mut() {
            carry += (*b as u32) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let mut out = Vec::with_capacity(bytes.len() + s.len());
    for c in s.bytes() {
        if c == b'1' {
            out.push(0);
        } else {
            break;
        }
    }
    out.extend(bytes.iter().rev());
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let cases: Vec<Vec<u8>> = vec![
            vec![0u8; 32],
            vec![1u8, 2, 3],
            (0u8..64).collect(),
            [
                0x84, 0xb6, 0xd7, 0x6c, 0x21, 0x2e, 0x6d, 0x52, 0x28, 0x5b, 0xd4, 0x5f, 0x29,
                0x57, 0xd6, 0x74, 0x5b, 0xd6, 0x71, 0x54, 0x7a, 0x5d, 0x29, 0x5d, 0x74, 0x5f,
                0x29, 0x57, 0xd6, 0x74, 0x5b, 0xd6,
            ]
            .to_vec(),
        ];
        for c in cases {
            let enc = encode(&c);
            assert_eq!(decode(&enc).unwrap(), c);
        }
    }

    #[test]
    fn known_vectors() {
        assert_eq!(encode(&[]), "");
        assert_eq!(encode(&[0]), "1");
        assert_eq!(encode(&[0, 0, 1]), "112");
        // "Programs use random public keys" — solana system program:
        let sys = decode("11111111111111111111111111111111").unwrap();
        assert_eq!(sys.len(), 32);
        assert!(sys.iter().all(|&b| b == 0));
    }
}
