//! 512-bit unsigned integer for the 128.128 price maths (kept out of the Anchor prelude's `Result` alias).
use uint::construct_uint;
construct_uint! { pub struct U512(8); }
