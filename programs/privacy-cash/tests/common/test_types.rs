use ark_circom::read_zkey;
fn test() {
    let () = read_zkey(std::fs::File::open("").unwrap()).unwrap();
}
