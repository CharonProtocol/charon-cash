use light_hasher::{Hasher, Poseidon};

use crate::common::constants::{DEFAULT_HEIGHT, ZERO_BYTES};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MerklePath {
    pub path_elements: Vec<[u8; 32]>,
    pub path_indices: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MerkleTreeSnapshot {
    pub levels: usize,
    pub zeros: Vec<[u8; 32]>,
    pub layers: Vec<Vec<[u8; 32]>>,
}

#[derive(Clone, Debug)]
pub struct MerkleTree {
    pub levels: usize,
    pub capacity: usize,
    pub zero_element: [u8; 32],
    zeros: Vec<[u8; 32]>,
    layers: Vec<Vec<[u8; 32]>>,
}

impl MerkleTree {
    pub fn new(levels: usize, elements: Vec<[u8; 32]>) -> Self {
        Self::new_with_zero(levels, elements, ZERO_BYTES[0])
    }

    pub fn new_with_zero(
        levels: usize,
        elements: Vec<[u8; 32]>,
        zero_element: [u8; 32],
    ) -> Self {
        let capacity = 1usize << levels;
        assert!(elements.len() <= capacity, "Tree is full");

        let mut zeros = Vec::with_capacity(levels + 1);
        zeros.push(zero_element);
        for i in 1..=levels {
            let z = Poseidon::hashv(&[&zeros[i - 1], &zeros[i - 1]])
                .expect("poseidon zero hash");
            zeros.push(z);
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
        if self.layers[0].len() >= self.capacity {
            panic!("Tree is full");
        }
        self.update(self.layers[0].len(), element);
    }

    pub fn bulk_insert(&mut self, elements: Vec<[u8; 32]>) {
        if self.layers[0].len() + elements.len() > self.capacity {
            panic!("Tree is full");
        }
        self.layers[0].extend(elements);
        self.rebuild();
    }

    pub fn update(&mut self, index: usize, element: [u8; 32]) {
        if index >= self.capacity || index > self.layers[0].len() {
            panic!("Insert index out of bounds: {}", index);
        }

        if index == self.layers[0].len() {
            self.layers[0].push(element);
        } else {
            self.layers[0][index] = element;
        }

        // Match the JS behavior: update only the affected branch.
        let mut idx = index;
        for level in 1..=self.levels {
            idx >>= 1;

            // JS reads missing siblings as the level's zero value.
            let left = self.layers[level - 1]
                .get(idx * 2)
                .copied()
                .unwrap_or(self.zeros[level - 1]);

            let right = self.layers[level - 1]
                .get(idx * 2 + 1)
                .copied()
                .unwrap_or(self.zeros[level - 1]);

            let hashed = Poseidon::hashv(&[&left, &right]).expect("poseidon hash");

            if self.layers.len() <= level {
                self.layers.push(Vec::new());
            }
            if self.layers[level].len() <= idx {
                self.layers[level].resize(idx + 1, self.zeros[level]);
            }

            self.layers[level][idx] = hashed;
        }
    }

    pub fn path(&self, index: usize) -> MerklePath {
        if index >= self.layers[0].len() {
            panic!("Index out of bounds: {}", index);
        }

        let mut path_elements = Vec::with_capacity(self.levels);
        let mut path_indices = Vec::with_capacity(self.levels);
        let mut idx = index;

        for level in 0..self.levels {
            path_indices.push(idx % 2);

            let sibling = if (idx ^ 1) < self.layers[level].len() {
                self.layers[level][idx ^ 1]
            } else {
                self.zeros[level]
            };

            path_elements.push(sibling);
            idx >>= 1;
        }

        MerklePath {
            path_elements,
            path_indices,
        }
    }

    pub fn index_of<F>(&self, element: &[u8; 32], comparator: Option<F>) -> isize
    where
        F: Fn(&[u8; 32], &[u8; 32]) -> bool,
    {
        if let Some(cmp) = comparator {
            self.layers[0]
                .iter()
                .position(|el| cmp(element, el))
                .map(|i| i as isize)
                .unwrap_or(-1)
        } else {
            self.layers[0]
                .iter()
                .position(|el| el == element)
                .map(|i| i as isize)
                .unwrap_or(-1)
        }
    }

    pub fn elements(&self) -> Vec<[u8; 32]> {
        self.layers[0].clone()
    }

    pub fn serialize(&self) -> MerkleTreeSnapshot {
        MerkleTreeSnapshot {
            levels: self.levels,
            zeros: self.zeros.clone(),
            layers: self.layers.clone(),
        }
    }

    pub fn deserialize(data: MerkleTreeSnapshot) -> Self {
        let capacity = 1usize << data.levels;

        Self {
            levels: data.levels,
            capacity,
            zero_element: data.zeros[0],
            zeros: data.zeros,
            layers: data.layers,
        }
    }

    fn rebuild(&mut self) {
        self.layers.truncate(1);

        for level in 1..=self.levels {
            let prev = self.layers[level - 1].clone();
            let mut next = Vec::with_capacity(prev.len().div_ceil(2));

            for i in 0..prev.len().div_ceil(2) {
                let left = prev[i * 2];
                let right = prev
                    .get(i * 2 + 1)
                    .copied()
                    .unwrap_or(self.zeros[level - 1]);

                next.push(Poseidon::hashv(&[&left, &right]).expect("poseidon hash"));
            }

            self.layers.push(next);
        }
    }
}