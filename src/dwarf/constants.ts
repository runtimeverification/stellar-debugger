/**
 * The subset of DWARF constants (v4/v5) needed by this parser: line-program
 * standard and extended opcodes, attribute forms (the complete set required to
 * skip any attribute by form), and the handful of attributes/tags/line-header
 * content types we actually read.
 *
 * Pure module (no `vscode` imports, no external deps).
 */

// Line-program standard opcodes (DW_LNS_*).
export const DW_LNS_copy = 0x01;
export const DW_LNS_advance_pc = 0x02;
export const DW_LNS_advance_line = 0x03;
export const DW_LNS_set_file = 0x04;
export const DW_LNS_set_column = 0x05;
export const DW_LNS_negate_stmt = 0x06;
export const DW_LNS_set_basic_block = 0x07;
export const DW_LNS_const_add_pc = 0x08;
export const DW_LNS_fixed_advance_pc = 0x09;
export const DW_LNS_set_prologue_end = 0x0a;
export const DW_LNS_set_epilogue_begin = 0x0b;
export const DW_LNS_set_isa = 0x0c;

// Line-program extended opcodes (DW_LNE_*).
export const DW_LNE_end_sequence = 0x01;
export const DW_LNE_set_address = 0x02;
export const DW_LNE_define_file = 0x03;

// Attribute forms (DW_FORM_*).
export const DW_FORM_addr = 0x01;
export const DW_FORM_block2 = 0x03;
export const DW_FORM_block4 = 0x04;
export const DW_FORM_data2 = 0x05;
export const DW_FORM_data4 = 0x06;
export const DW_FORM_data8 = 0x07;
export const DW_FORM_string = 0x08;
export const DW_FORM_block = 0x09;
export const DW_FORM_block1 = 0x0a;
export const DW_FORM_data1 = 0x0b;
export const DW_FORM_flag = 0x0c;
export const DW_FORM_sdata = 0x0d;
export const DW_FORM_strp = 0x0e;
export const DW_FORM_udata = 0x0f;
export const DW_FORM_ref_addr = 0x10;
export const DW_FORM_ref1 = 0x11;
export const DW_FORM_ref2 = 0x12;
export const DW_FORM_ref4 = 0x13;
export const DW_FORM_ref8 = 0x14;
export const DW_FORM_ref_udata = 0x15;
export const DW_FORM_indirect = 0x16;
export const DW_FORM_sec_offset = 0x17;
export const DW_FORM_exprloc = 0x18;
export const DW_FORM_flag_present = 0x19;
export const DW_FORM_strx = 0x1a;
export const DW_FORM_addrx = 0x1b;
export const DW_FORM_ref_sup4 = 0x1c;
export const DW_FORM_strp_sup = 0x1d;
export const DW_FORM_data16 = 0x1e;
export const DW_FORM_line_strp = 0x1f;
export const DW_FORM_ref_sig8 = 0x20;
export const DW_FORM_implicit_const = 0x21;
export const DW_FORM_loclistx = 0x22;
export const DW_FORM_rnglistx = 0x23;
export const DW_FORM_ref_sup8 = 0x24;
export const DW_FORM_strx1 = 0x25;
export const DW_FORM_strx2 = 0x26;
export const DW_FORM_strx3 = 0x27;
export const DW_FORM_strx4 = 0x28;
export const DW_FORM_addrx1 = 0x29;
export const DW_FORM_addrx2 = 0x2a;
export const DW_FORM_addrx3 = 0x2b;
export const DW_FORM_addrx4 = 0x2c;

// Attributes (DW_AT_*) read from the compilation-unit root DIE.
export const DW_AT_name = 0x03;
export const DW_AT_stmt_list = 0x10;
export const DW_AT_comp_dir = 0x1b;

// Tags (DW_TAG_*).
export const DW_TAG_compile_unit = 0x11;

// DWARF v5 line-header entry-format content types (DW_LNCT_*).
export const DW_LNCT_path = 0x01;
export const DW_LNCT_directory_index = 0x02;

// Tags (DW_TAG_*) — DIE-tree / type parsing.
export const DW_TAG_array_type = 0x01;
export const DW_TAG_enumeration_type = 0x04;
export const DW_TAG_formal_parameter = 0x05;
export const DW_TAG_lexical_block = 0x0b;
export const DW_TAG_member = 0x0d;
export const DW_TAG_pointer_type = 0x0f;
export const DW_TAG_structure_type = 0x13;
export const DW_TAG_typedef = 0x16;
export const DW_TAG_union_type = 0x17;
export const DW_TAG_subrange_type = 0x21;
export const DW_TAG_base_type = 0x24;
export const DW_TAG_const_type = 0x26;
export const DW_TAG_enumerator = 0x28;
export const DW_TAG_variant_part = 0x33;
export const DW_TAG_variable = 0x34;
export const DW_TAG_volatile_type = 0x35;
export const DW_TAG_subprogram = 0x2e;
export const DW_TAG_variant = 0x59;

// Attributes (DW_AT_*) — variables, types, scopes, locations.
export const DW_AT_location = 0x02;
export const DW_AT_byte_size = 0x0b;
export const DW_AT_bit_size = 0x0d;
export const DW_AT_low_pc = 0x11;
export const DW_AT_high_pc = 0x12;
export const DW_AT_discr = 0x15;
export const DW_AT_discr_value = 0x1e;
export const DW_AT_upper_bound = 0x2f;
export const DW_AT_count = 0x37;
export const DW_AT_data_member_location = 0x38;
export const DW_AT_const_value = 0x1c;
export const DW_AT_declaration = 0x3c;
export const DW_AT_encoding = 0x3e;
export const DW_AT_frame_base = 0x40;
export const DW_AT_type = 0x49;
export const DW_AT_ranges = 0x55;
export const DW_AT_data_bit_offset = 0x6b;

// Base-type encodings (DW_ATE_*).
export const DW_ATE_address = 0x01;
export const DW_ATE_boolean = 0x02;
export const DW_ATE_float = 0x04;
export const DW_ATE_signed = 0x05;
export const DW_ATE_signed_char = 0x06;
export const DW_ATE_unsigned = 0x07;
export const DW_ATE_unsigned_char = 0x08;
export const DW_ATE_UTF = 0x10;

// Location/expression opcodes (DW_OP_*).
export const DW_OP_addr = 0x03;
export const DW_OP_plus_uconst = 0x23;
export const DW_OP_fbreg = 0x91;
export const DW_OP_piece = 0x93;
export const DW_OP_bit_piece = 0x9d;
export const DW_OP_stack_value = 0x9f;
export const DW_OP_WASM_location = 0xed;
