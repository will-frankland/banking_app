import React from "react";
import { FormField, FormLabel, FormControl, FormMessage } from "./ui/form";
import { Input } from "@/components/ui/input";
import { FieldPath, Form } from "react-hook-form";
import { authFormSchema } from "@/lib/utils";
import { Control } from "react-hook-form";
import { z } from "zod";

interface CustomInputProps {
  control: Control<z.infer<typeof authFormSchema>>;
  name: FieldPath<z.infer<typeof authFormSchema>>,
  label: string;
  placeholder: string;
}

const CustomInput = ({ control, name, label, placeholder }: CustomInputProps) => {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <div className="form-item">
          <FormLabel className="form-label">{label}</FormLabel>
          <div className="flex w-full flex-col">
            <FormControl>
              <Input
                placeholder={placeholder}
                className="input-class"
                {...field}
              />
            </FormControl>
            <FormMessage className="form-message mt-2" />
          </div>
        </div>
      )}
    />
  );
};

export default CustomInput;
