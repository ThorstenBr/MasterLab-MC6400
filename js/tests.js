/* INS8070 CPU instruction set tests.
 * 
 * Simple tests for debugging/development.
 *
 * https://github.com/ThorstenBr/MasterLab-MC6400
 *  
 * Copyright 2024 Thorsten Brehm, brehmt (at) gmail com
 */

const JMP = 0x24;
const NOP = 0x00;
const JSR = 0x20;
const RET = 0x5C;
const LDA = 0xC4;  // LOAD BYTE IMMEDIATE
const LDAD = 0xC5; // LOAD FROM ADDRESS
const SR  = 0x3C;
const SRL = 0x3D;
const RRA = 0x3E;
const RRL = 0x3F;
const STA = 0xCD;
const XCHAE = 0x01;
const CALL_D = 0x1D;
const CALL_2 = 0x12; // BLANK ROUTINE
const CALL_0 = 0x10; // ANZ_EIN ROUTINE
const BRA  = 0x74;
const AND = 0xD4;

TestVECTORS = [NOP, JMP, 0xFF, 0xF, JMP, 0, 0, JMP, 0, 0]; // 00-09: RESET + 2x IRQ vectors

TestROM1 = [0xC4, 2+4+8, // LD A 2+4+8
			 0x07, // LD S,A
			 0xCD, 0xC3, // ST A FFC3h
			 0x4C, 0x4D, 0x4E, 0x4F];

TestBRANCH1 = [0xC4, 0x16,
			  0xFC, 0x01,
			  NOP,
			  0x74, 0xFB
			  ];

TestBRANCH2 = [0xC4, 0x16,
			  0xFC, 0x01,
			  NOP,
			  NOP, NOP,
			  NOP, NOP, NOP, NOP,
			  NOP, NOP, NOP, NOP,
			  NOP, NOP,
			  0x74, 0x1B // => BRA 102E
			  ];

TestSHIFTROTATE = [LDA, 1,
                   RRL,
                   RRL,
                   RRL,
                   LDA, 2,
                   RRA,
                   RRA,
                   RRA,
                   LDA, 2,
                   SR,
                   SR,
                   SR,
                   LDA, 1,
                   RRL,
                   SRL,
                   SRL]

VECTORProgram2 = [NOP, JMP, 0xCB, 0x3, JMP, 0, 0, JMP, 0, 0]; // 00-09: RESET + 2x IRQ vectors

TestCALL = [LDA, 0,
            XCHAE,
            LDA, 3,
            CALL_D,
            NOP,
            NOP,
            BRA,
            0xF5];

TestButtons = [CALL_2,    // blank display
               CALL_0,    // DISPLAY+INPUT
               BRA, 0x08, // BLUE FUNCTION KEY
               STA, 0xE0, // STORE KEY
               LDA, 0xEE, // EE="A"
               STA, 0xC7, // DIGIT 7
               BRA, 0x6,  // BRANCH AHEAD
               
               STA, 0xE0, // STORE KEY (ALPHANUM)
               LDA, 0xE2, // E2="F"
               STA, 0xC7, // DIGIT 7

               0x84, 0x00, 0x00, // LD EA,=0000
               LDAD, 0xE0, // LOAD KEY IN A
               SR, SR, SR, SR, // SHIFT RIGHT 4
               0xB4, 0xDE, 0x00, // ADD EA,=00DE ; ADD 7SEGMENT-SYMBOL TABLE OFFSET
               0x4E, //       XCH EA,P2     
               0xC2, 0x00, // LD A,00,P2    
               STA, 0xC1,  // DIGIT 1
               
               0x84, 0x00, 0x00, // LD EA,=0000
               LDAD, 0xE0, // LOAD KEY IN A
               AND, 0x0F,  // MASK LOWER NIBBLE
               0xB4, 0xDE, 0x00, // ADD EA,=00DE ; ADD 7SEGMENT-SYMBOL TABLE OFFSET
               0x4E, //       XCH EA,P2     
               0xC2, 0x00, // LD A,00,P2    
               STA, 0xC0,  // DIGIT 0

               BRA, 0xCD
              ];

TestINSTRUCTIONS = [ 
                     0x84, 0x34, 0x12, // LD EA,=1234
                     0x40, //       LD A,E        ; COPY BUTTON STATE IN A (UPPER NIBBLE)
                     0xD4, 0x40, //    AND A,=40     ; CHECK BIT 6: FUNCTION KEY PRESSED?
                     NOP
                   ];

VECTORdebug = [NOP, JMP, 0xEA, 0x8, JMP, 0, 0, JMP, 0, 0]; // 00-09: RESET + 2x IRQ vectors

// load test program
load_program(0x0000, TestVECTORS); // overwrite reset vector in ROM
//load_program(0x1000, TestCALL);  // load test program into RAM

//load_program(0x0, VECTORdebug);
load_program(0x1000, TestButtons);
//load_program(0x1000, TestINSTRUCTIONS);

cpu_show();
