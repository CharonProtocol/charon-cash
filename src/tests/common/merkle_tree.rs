use light_hasher::{Hasher, Poseidon};

use crate::tests::common::constants::{DEFAULT_HEIGHT, ROOT_HISTORY_SIZE, ZERO_BYTES};

#[derive(Clone, Debug)]
pub struct MerkleTree {
    pub levels: usize,
    pub capacity: usize,
    pub zero_element: [u8; 32],
    zeros: Vec<[u8; 32]>,
    layers: Vec<Vec<[u8; 32]>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MerklePath {
    pub index: usize,
    pub path_elements: Vec<[u8; 32]>,
}

impl MerkleTree {
    pub fn new(levels: usize, elements: Vec<[u8; 32]>) -> Self {
        Self::new_with_zero(levels, elements, ZERO_BYTES[0])
    }

    pub fn new_with_zero(levels: usize, elements: Vec<[u8; 32]>, zero_element: [u8; 32]) -> Self {
        let capacity = 1usize << levels;
        assert!(elements.len() <= capacity, "Tree is full");

        let mut zeros = Vec::with_capacity(levels + 1);
        zeros.push(zero_element);
        for i in 1..=levels {
            zeros.push(
                Poseidon::hashv(&[&zeros[i - 1], &zeros[i - 1]]).expect("poseidon zero hash"),
            );
        }

        let mut tree = Self {
            levels,
            capacity,
            zero_element,
            zeros,
            layers: vec![elements],
        };
        tree.rebuild();
        tree
    }

    pub fn default() -> Self {
        Self::new(DEFAULT_HEIGHT, Vec::new())
    }

    pub fn root(&self) -> [u8; 32] {
        self.layers
            .get(self.levels)
            .and_then(|lvl| lvl.first().copied())
            .unwrap_or(self.zeros[self.levels])
    }

    pub fn insert(&mut self, element: [u8; 32]) {
        assert!(self.layers[0].len() < self.capacity, "Tree is full");
        self.update(self.layers[0].len(), element);
    }

    pub fn bulk_insert(&mut self, elements: Vec<[u8; 32]>) {
        assert!(
            self.layers[0].len() + elements.len() <= self.capacity,
            "Tree is full"
        );
        self.layers[0].extend(elements);
        self.rebuild();
    }

    pub fn update(&mut self, index: usize, element: [u8; 32]) {
        assert!(index < self.capacity, "Index out of bounds");
        if self.layers[0].len() <= index {
            self.layers[0].resize(index + 1, self.zero_element);
        }
        self.layers[0][index] = element;
        self.rebuild();
    }

    pub fn elements(&self) -> &[ [u8; 32] ] {
        &self.layers[0]
    }

    pub fn path(&self, index: usize) -> MerklePath {
        assert!(index < self.layers[0].len(), "Index out of bounds");

        let mut path_elements = Vec::with_capacity(self.levels);
        let mut current_index = index;

        for level in 0..self.levels {
            let sibling_index = if current_index % 2 == 0 {
                current_index + 1
            } else {
                current_index - 1
            };

            let sibling = self.layers[level]
                .get(sibling_index)
                .copied()
                .unwrap_or(self.zeros[level]);
            path_elements.push(sibling);
            current_index /= 2;
        }

        MerklePath { index, path_elements }
    }

    pub fn is_known_root(&self, root: [u8; 32]) -> bool {
        root == self.root() || self.layers[self.levels].iter().any(|r| *r == root)
    }

    fn rebuild(&mut self) {
        self.layers.truncate(1);

        for level in 1..=self.levels {
            let prev = self.layers[level - 1].clone();
            let mut next = Vec::with_capacity(prev.len().div_ceil(2));

            for i in 0..prev.len().div_ceil(2) {
                let left = prev[i * 2];
                let right = prev.get(i * 2 + 1).copied().unwrap_or(self.zeros[level - 1]);
                next.push(Poseidon::hashv(&[&left, &right]).expect("poseidon hash"));
            }

            self.layers.push(next);
        }
    }
}