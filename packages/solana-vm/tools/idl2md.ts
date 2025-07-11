#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';

/**
 * Interface definitions for Anchor IDL structure
 */

// Field in a struct or account
interface Field {
  name: string;
  type: any;
  docs?: string[];
}

// Struct type definition
interface StructType {
  kind: string;
  fields: Field[];
}

// Account definition
interface Account {
  name: string;
  type?: StructType;
  docs?: string[];
  discriminator?: number[];
}

// Instruction argument
interface Argument {
  name: string;
  type: any;
}

// Instruction definition
interface Instruction {
  name: string;
  accounts: any[];
  args: Argument[];
  docs?: string[];
  discriminator?: number[];
}

// Error definition
interface ErrorDef {
  code: number;
  name: string;
  msg: string;
}

// Type definition
interface TypeDef {
  name: string;
  type?: StructType;
  docs?: string[];
}

// Event definition
interface Event {
  name: string;
  type?: StructType;
  docs?: string[];
  discriminator?: number[];
}

// Complete IDL structure
interface IDL {
  version?: string;
  name?: string;
  metadata?: {
    name?: string;
    description?: string;
    version?: string;
    spec?: string;
  };
  address?: string;
  instructions: Instruction[];
  accounts?: Account[];
  types?: TypeDef[];
  events?: Event[];
  errors?: ErrorDef[];
}

/**
 * Converts a type object to its string representation
 * @param typeInfo - The type information to convert
 * @returns String representation of the type
 */
function convertTypeToString(typeInfo: any): string {
  if (typeof typeInfo === 'string') {
    return typeInfo;
  } else if (typeof typeInfo === 'object') {
    if (typeInfo.defined) {
      return typeInfo.defined.name;
    } else if (typeInfo.option) {
      return `Option<${convertTypeToString(typeInfo.option)}>`;
    } else if (typeInfo.array) {
      const elementType = convertTypeToString(typeInfo.array[0]);
      const size = typeInfo.array[1];
      return `[${elementType}; ${size}]`;
    } else if (typeInfo.vec) {
      const elementType = convertTypeToString(typeInfo.vec);
      return `Vec<${elementType}>`;
    } else {
      return JSON.stringify(typeInfo);
    }
  } else {
    return String(typeInfo);
  }
}

/**
 * Formats Rustdoc-style documentation into Markdown
 * @param docs - Array of documentation strings
 * @returns Formatted markdown documentation
 */
function formatRustdoc(docs?: string[]): string {
  if (!docs || docs.length === 0) return '';
  
  // Join all documentation lines
  const fullDoc = docs.join('\n');
  
  // Process the documentation
  let formattedDoc = '';
  let inCodeBlock = false;
  let currentSection = '';
  
  // Process each line
  const lines = fullDoc.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Handle section headers (e.g., # Parameters, # Returns)
    if (line.trim().startsWith('# ')) {
      // Add a markdown heading
      const headingText = line.trim().substring(2);
      formattedDoc += `### ${headingText}\n\n`;
      continue;
    }
    
    // Handle code blocks
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      formattedDoc += line + '\n';
      continue;
    }
    
    // If we're in a code block, don't process further
    if (inCodeBlock) {
      formattedDoc += line + '\n';
      continue;
    }
    
    // Handle list items (e.g., * `param` - Description)
    if (line.trim().startsWith('* ')) {
      const item = line.trim().substring(2);
      // Check if it's a parameter description with a code reference
      const paramMatch = item.match(/^`([^`]+)`\s*-\s*(.+)$/);
      if (paramMatch) {
        const [, paramName, paramDesc] = paramMatch;
        formattedDoc += `- **${paramName}**: ${paramDesc}\n`;
      } else {
        formattedDoc += `- ${item}\n`;
      }
      continue;
    }
    
    // Handle empty lines
    if (line.trim() === '') {
      // Only add a blank line if the previous line wasn't a blank line
      if (i > 0 && lines[i-1].trim() !== '') {
        formattedDoc += '\n';
      }
      continue;
    }
    
    // Regular text
    formattedDoc += line + '\n';
  }
  
  return formattedDoc;
}

/**
 * Finds a type definition by name
 * @param types - Array of type definitions
 * @param name - Name of the type to find
 * @returns The type definition or undefined if not found
 */
function findTypeByName(types: TypeDef[] | undefined, name: string): TypeDef | undefined {
  if (!types) return undefined;
  return types.find(type => type.name === name);
}

/**
 * Formats account information into a Markdown table
 * @param accounts - List of account objects
 * @param types - List of type definitions
 * @returns Markdown formatted table
 */
function formatAccounts(accounts: any[], types?: TypeDef[]): string {
  if (!accounts || accounts.length === 0) {
    return "None";
  }
  
  let result = "| Name | Writable | Signer | Description |\n";
  result += "| ---- | -------- | ------ | ----------- |\n";
  
  for (const account of accounts) {
    const name = account.name || '';
    const writable = account.writable ? "✓" : "";
    const signer = account.signer ? "✓" : "";
    
    // Look for documentation in the account or in the related type
    let docText = '';
    if (account.docs && account.docs.length > 0) {
      // For account docs in tables, just use the first line
      docText = account.docs[0];
    } else if (types && account.name) {
      // Try to find matching type definition
      const typeDef = findTypeByName(types, account.name);
      if (typeDef && typeDef.docs && typeDef.docs.length > 0) {
        docText = typeDef.docs[0];
      }
    }
    
    result += `| ${name} | ${writable} | ${signer} | ${docText} |\n`;
  }
  
  return result;
}

/**
 * Formats arguments into a Markdown table
 * @param args - List of argument objects
 * @returns Markdown formatted table
 */
function formatArgs(args: Argument[]): string {
  if (!args || args.length === 0) {
    return "None";
  }
  
  let result = "| Name | Type | Description |\n";
  result += "| ---- | ---- | ----------- |\n";
  
  for (const arg of args) {
    const name = arg.name || '';
    const typeStr = convertTypeToString(arg.type || '');
    result += `| ${name} | ${typeStr} | |\n`;
  }
  
  return result;
}

/**
 * Formats struct fields into a Markdown table
 * @param fields - List of field objects
 * @returns Markdown formatted table
 */
function formatStructFields(fields: Field[]): string {
  if (!fields || fields.length === 0) {
    return "None";
  }
  
  let result = "| Name | Type | Description |\n";
  result += "| ---- | ---- | ----------- |\n";
  
  for (const field of fields) {
    const name = field.name || '';
    const typeStr = convertTypeToString(field.type || '');
    const docText = field.docs && field.docs.length > 0 ? field.docs[0] : '';
    
    result += `| ${name} | ${typeStr} | ${docText} |\n`;
  }
  
  return result;
}

/**
 * Converts an Anchor IDL to Markdown documentation
 * @param idl - The Anchor IDL object
 * @returns Markdown formatted documentation
 */
function convertIdlToMarkdown(idl: IDL): string {
  // Create title with program name
  const programName = idl.metadata?.name || idl.name || 'Program';
  let md = `# ${programName} API Documentation\n\n`;
  
  // Add program description
  const description = idl.metadata?.description || '';
  if (description) {
    md += `${description}\n\n`;
  }
  
  // Add program address
  const address = idl.address || '';
  if (address) {
    md += `Program Address: \`${address}\`\n\n`;
  }
  
  // Changed order: Types first
  // Add types section
  if (idl.types && idl.types.length > 0) {
    md += "## Types\n\n";
    
    for (const typeInfo of idl.types) {
      const name = typeInfo.name || '';
      md += `### ${name}\n\n`;
      
      // Add type description with Rustdoc formatting
      if (typeInfo.docs && typeInfo.docs.length > 0) {
        md += `${formatRustdoc(typeInfo.docs)}\n`;
      }
      
      // Add fields
      if (typeInfo.type && typeInfo.type.kind === 'struct') {
        const fields = typeInfo.type.fields || [];
        md += "#### Fields\n\n";
        md += formatStructFields(fields);
        md += "\n\n";
      }
    }
  }
  
  // Add accounts section
  if (idl.accounts && idl.accounts.length > 0) {
    md += "## Accounts\n\n";
    
    for (const account of idl.accounts) {
      const name = account.name || '';
      md += `### ${name}\n\n`;
      
      // Try to find documentation for this account
      let accountDocs = account.docs;
      
      // If no docs in account, look for matching type
      if ((!accountDocs || accountDocs.length === 0) && idl.types) {
        const typeDef = findTypeByName(idl.types, name);
        if (typeDef) {
          accountDocs = typeDef.docs;
        }
      }
      
      // Add account description with Rustdoc formatting
      if (accountDocs && accountDocs.length > 0) {
        md += `${formatRustdoc(accountDocs)}\n`;
      }
      
      // Add fields
      if (account.type && account.type.kind === 'struct') {
        const fields = account.type.fields || [];
        md += "#### Fields\n\n";
        md += formatStructFields(fields);
        md += "\n\n";
      }
    }
  }
  
  // Add instructions section
  if (idl.instructions && idl.instructions.length > 0) {
    md += "## Instructions\n\n";
    
    for (const instr of idl.instructions) {
      const name = instr.name || '';
      md += `### ${name}\n\n`;
      
      // Add instruction description with Rustdoc formatting
      if (instr.docs && instr.docs.length > 0) {
        md += `${formatRustdoc(instr.docs)}\n`;
      }
      
      // Add accounts
      md += "#### Accounts\n\n";
      md += formatAccounts(instr.accounts || [], idl.types);
      md += "\n\n";
      
      // Add arguments
      md += "#### Arguments\n\n";
      md += formatArgs(instr.args || []);
      md += "\n\n";
    }
  }
  
  // Add events section
  if (idl.events && idl.events.length > 0) {
    md += "## Events\n\n";
    
    for (const event of idl.events) {
      const name = event.name || '';
      md += `### ${name}\n\n`;
      
      // Try to find documentation for this event
      let eventDocs = event.docs;
      
      // If no docs in event, look for matching type
      if ((!eventDocs || eventDocs.length === 0) && idl.types) {
        const typeDef = findTypeByName(idl.types, name);
        if (typeDef) {
          eventDocs = typeDef.docs;
        }
      }
      
      // Add event description with Rustdoc formatting
      if (eventDocs && eventDocs.length > 0) {
        md += `${formatRustdoc(eventDocs)}\n`;
      }
      
      // Add fields
      if (event.type && event.type.kind === 'struct') {
        const fields = event.type.fields || [];
        md += "#### Fields\n\n";
        md += formatStructFields(fields);
        md += "\n\n";
      }
    }
  }
  
  // Add errors section
  if (idl.errors && idl.errors.length > 0) {
    md += "## Errors\n\n";
    
    md += "| Code | Name | Message |\n";
    md += "| ---- | ---- | ------- |\n";
    
    for (const error of idl.errors) {
      const code = error.code || '';
      const name = error.name || '';
      const msg = error.msg || '';
      
      md += `| ${code} | ${name} | ${msg} |\n`;
    }
  }
  
  return md;
}

/**
 * Main function to execute when script is run directly
 */
function main(): void {
  const args = process.argv.slice(2);
  let inputFile: string | null = null;
  let outputFile: string | null = null;

  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--output') {
      outputFile = args[i + 1];
      i++;
    } else if (!inputFile && !args[i].startsWith('-')) {
      inputFile = args[i];
    }
  }

  try {
    let idlContent: string;
    
    // Read input from file or stdin
    if (inputFile) {
      // Read from specified file
      idlContent = fs.readFileSync(inputFile, 'utf8');
    } else {
      // Read from standard input
      const buffer = fs.readFileSync(0); // STDIN_FILENO = 0
      idlContent = buffer.toString();
    }

    // Parse IDL JSON
    const idl: IDL = JSON.parse(idlContent);
    
    // Convert to Markdown
    const markdown = convertIdlToMarkdown(idl);
    
    // Output result to file or stdout
    if (outputFile) {
      fs.writeFileSync(outputFile, markdown);
      console.log(`Markdown written to ${outputFile}`);
    } else {
      console.log(markdown);
    }
  } catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Execute main function if script is run directly
if (require.main === module) {
  main();
}

// Export for module usage
export {
  convertIdlToMarkdown,
  IDL
};